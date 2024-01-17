import assert, {fail} from "node:assert";
import {Readable, Writable} from "node:stream";
import {normalizeConfig} from "../src/config.js";
import type {DeployEffects} from "../src/deploy.js";
import {deploy, promptConfirm} from "../src/deploy.js";
import {CliError, isHttpError} from "../src/error.js";
import type {Logger} from "../src/logger.js";
import {commandRequiresAuthenticationMessage} from "../src/observableApiAuth.js";
import type {DeployConfig} from "../src/observableApiConfig.js";
import {MockLogger} from "./mocks/logger.js";
import {getCurentObservableApi, mockObservableApi} from "./mocks/observableApi.js";
import {invalidApiKey, validApiKey} from "./mocks/observableApi.js";

// These files are implicitly generated by the CLI. This may change over time,
// so they’re enumerated here for clarity. TODO We should enforce that these
// files are specifically uploaded, rather than just the number of files.
const EXTRA_FILES: string[] = [
  "_observablehq/client.js",
  "_observablehq/runtime.js",
  "_observablehq/stdlib.js",
  "_observablehq/stdlib/dot.js",
  "_observablehq/stdlib/duckdb.js",
  "_observablehq/stdlib/inputs.css",
  "_observablehq/stdlib/inputs.js",
  "_observablehq/stdlib/mermaid.js",
  "_observablehq/stdlib/sqlite.js",
  "_observablehq/stdlib/tex.js",
  "_observablehq/stdlib/vega-lite.js",
  "_observablehq/stdlib/xlsx.js",
  "_observablehq/stdlib/zip.js",
  "_observablehq/style.css"
];

interface MockDeployEffectsOptions {
  apiKey?: string | null;
  deployConfig?: DeployConfig | null;
  isTty?: boolean;
  outputColumns?: number;
  debug?: boolean;
}

class MockDeployEffects implements DeployEffects {
  public logger = new MockLogger();
  public input = new Readable();
  public output: NodeJS.WritableStream;
  public observableApiKey: string | null = null;
  public deployConfig: DeployConfig | null = null;
  public projectTitle = "My Project";
  public projectSlug = "my-project";
  public isTty: boolean;
  public outputColumns: number;
  private ioResponses: {prompt: RegExp; response: string}[] = [];
  private debug: boolean;

  constructor({
    apiKey = validApiKey,
    deployConfig = null,
    isTty = true,
    outputColumns = 80,
    debug = false
  }: MockDeployEffectsOptions = {}) {
    this.observableApiKey = apiKey;
    this.deployConfig = deployConfig;
    this.isTty = isTty;
    this.outputColumns = outputColumns;
    this.debug = debug;

    this.output = new Writable({
      write: (data, _enc, callback) => {
        const dataString = data.toString();
        let matched = false;
        for (const [index, {prompt, response}] of this.ioResponses.entries()) {
          if (dataString.match(prompt)) {
            // Having to null/reinit input seems wrong.
            // TODO: find the correct way to submit to readline but keep the same
            // input stream across multiple readline interactions.
            this.input.push(`${response}\n`);
            this.input.push(null);
            this.input = new Readable();
            this.ioResponses.splice(index, 1);
            matched = true;
            break;
          }
        }
        if (!matched && debug) console.debug("Unmatched output:", dataString);
        callback();
      }
    });
  }

  async getObservableApiKey(logger: Logger) {
    if (!this.observableApiKey) {
      logger.log(commandRequiresAuthenticationMessage);
      throw new Error("no key available in this test");
    }
    return {source: "test" as const, key: this.observableApiKey};
  }

  async getDeployConfig() {
    return this.deployConfig;
  }

  async setDeployConfig(sourceRoot: string, config: DeployConfig) {
    this.deployConfig = config;
  }

  addIoResponse(prompt: RegExp, response: string) {
    this.ioResponses.push({prompt, response});
    return this;
  }

  close() {
    assert.deepEqual(this.ioResponses, []);
  }
}

// This test should have exactly one index.md in it, and nothing else; that one
// page is why we +1 to the number of extra files.
const TEST_SOURCE_ROOT = "test/input/build/simple-public";
const TEST_CONFIG = await normalizeConfig({
  root: TEST_SOURCE_ROOT,
  title: "Mock BI",
  deploy: {workspace: "mock-user-ws", project: "bi"}
});

// TODO These tests need mockJsDelivr, too!
describe("deploy", () => {
  mockObservableApi();

  it("makes expected API calls for an existing project", async () => {
    const projectId = "project123";
    const deployConfig = {projectId};
    const deployId = "deploy456";
    getCurentObservableApi()
      .handleGetProject({
        workspaceLogin: TEST_CONFIG.deploy!.workspace,
        projectSlug: TEST_CONFIG.deploy!.project,
        projectId
      })
      .handlePostDeploy({projectId, deployId})
      .handlePostDeployFile({deployId, repeat: EXTRA_FILES.length + 1})
      .handlePostDeployUploaded({deployId})
      .start();

    const effects = new MockDeployEffects({deployConfig}).addIoResponse(/^Deploy message: /, "fix some bugs");
    await deploy({config: TEST_CONFIG}, effects);

    effects.close();
  });

  it("makes expected API calls for non-existent project, user chooses to create", async () => {
    const projectId = "project123";
    const deployConfig = {projectId};
    const deployId = "deploy456";
    getCurentObservableApi()
      .handleGetProject({
        workspaceLogin: TEST_CONFIG.deploy!.workspace,
        projectSlug: TEST_CONFIG.deploy!.project,
        projectId,
        status: 404
      })
      .handleGetUser()
      .handlePostProject({projectId})
      .handlePostDeploy({projectId, deployId})
      .handlePostDeployFile({deployId, repeat: EXTRA_FILES.length + 1})
      .handlePostDeployUploaded({deployId})
      .start();

    const effects = new MockDeployEffects({deployConfig, isTty: true})
      .addIoResponse(/Do you want to create it now\?/, "y")
      .addIoResponse(/^Deploy message: /, "fix some bugs");

    await deploy({config: TEST_CONFIG}, effects);

    effects.close();
  });

  it("makes expected API calls for non-existent project, user chooses not to create", async () => {
    const projectId = "project123";
    const deployConfig = {projectId};
    getCurentObservableApi()
      .handleGetProject({
        workspaceLogin: TEST_CONFIG.deploy!.workspace,
        projectSlug: TEST_CONFIG.deploy!.project,
        projectId,
        status: 404
      })
      .start();

    const effects = new MockDeployEffects({deployConfig, isTty: true}).addIoResponse(
      /Do you want to create it now\?/,
      "n"
    );

    try {
      await deploy({config: TEST_CONFIG}, effects);
      assert.fail("expected error");
    } catch (error) {
      CliError.assert(error, {message: "User cancelled deploy.", print: false, exitCode: 0});
    }

    effects.close();
  });

  it("makes expected API calls for non-existent project, non-interactive", async () => {
    const projectId = "project123";
    const deployConfig = {projectId};
    getCurentObservableApi()
      .handleGetProject({
        workspaceLogin: TEST_CONFIG.deploy!.workspace,
        projectSlug: TEST_CONFIG.deploy!.project,
        projectId,
        status: 404
      })
      .start();

    const effects = new MockDeployEffects({deployConfig, isTty: false});

    try {
      await deploy({config: TEST_CONFIG}, effects);
      assert.fail("expected error");
    } catch (error) {
      CliError.assert(error, {message: "Cancelling deploy due to non-existent project."});
    }

    effects.close();
  });

  it("throws an error if project doesn't exist and config has no title", async () => {
    const projectId = "project123";
    const deployConfig = {projectId};
    const config = await normalizeConfig({
      root: TEST_SOURCE_ROOT,
      // no title!
      deploy: {workspace: "mock-user-ws", project: "bi"}
    });
    getCurentObservableApi()
      .handleGetProject({
        workspaceLogin: config.deploy!.workspace,
        projectSlug: config.deploy!.project,
        projectId,
        status: 404
      })
      .start();
    const effects = new MockDeployEffects({deployConfig, isTty: true});

    try {
      await deploy({config}, effects);
      assert.fail("expected error");
    } catch (err) {
      CliError.assert(err, {message: /You haven't configured a project title/});
    }

    effects.close();
  });

  it("throws an error if project doesn't exist and workspace doesn't exist", async () => {
    const projectId = "project123";
    const deployConfig = {projectId};
    const config = await normalizeConfig({
      root: TEST_SOURCE_ROOT,
      title: "Some title",
      deploy: {workspace: "super-ws-123", project: "bi"}
    });
    getCurentObservableApi()
      .handleGetProject({
        workspaceLogin: config.deploy!.workspace,
        projectSlug: config.deploy!.project,
        projectId,
        status: 404
      })
      .handleGetUser()
      .start();

    const effects = new MockDeployEffects({deployConfig, isTty: true}).addIoResponse(
      /Do you want to create it now\?/,
      "y"
    );

    try {
      await deploy({config}, effects);
      assert.fail("expected error");
    } catch (err) {
      CliError.assert(err, {message: /Workspace super-ws-123 not found/});
    }

    effects.close();
  });

  it("throws an error if workspace is invalid", async () => {
    const config = await normalizeConfig({
      root: TEST_SOURCE_ROOT,
      deploy: {workspace: "ACME Inc.", project: "bi"}
    });
    const effects = new MockDeployEffects({isTty: true});

    try {
      await deploy({config}, effects);
      assert.fail("expected error");
    } catch (err) {
      CliError.assert(err, {message: /"ACME Inc.".*isn't valid.*"acme-inc"/});
    }

    effects.close();
  });

  it("throws an error if project is invalid", async () => {
    const config = await normalizeConfig({
      root: TEST_SOURCE_ROOT,
      deploy: {workspace: "acme", project: "Business Intelligence"}
    });
    const effects = new MockDeployEffects({isTty: true});

    try {
      await deploy({config}, effects);
      assert.fail("expected error");
    } catch (err) {
      CliError.assert(err, {message: /"Business Intelligence".*isn't valid.*"business-intelligence"/});
    }

    effects.close();
  });

  it("shows message for missing API key", async () => {
    const effects = new MockDeployEffects({apiKey: null});

    try {
      await deploy({config: TEST_CONFIG}, effects);
      assert.fail("expected error");
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      assert.equal(err.message, "no key available in this test");
      effects.logger.assertExactLogs([/^You need to be authenticated/]);
    }
  });

  it("throws an error with an invalid API key", async () => {
    getCurentObservableApi()
      .handleGetProject({
        workspaceLogin: TEST_CONFIG.deploy!.workspace,
        projectSlug: TEST_CONFIG.deploy!.project,
        status: 401
      })
      .start();
    const effects = new MockDeployEffects({apiKey: invalidApiKey});

    try {
      await deploy({config: TEST_CONFIG}, effects);
      assert.fail("Should have thrown");
    } catch (error) {
      assert.ok(isHttpError(error));
      assert.equal(error.statusCode, 401);
    }
  });

  it("throws an error if deploy creation fails", async () => {
    const projectId = "project123";
    const deployId = "deploy456";
    getCurentObservableApi()
      .handleGetProject({
        workspaceLogin: TEST_CONFIG.deploy!.workspace,
        projectSlug: TEST_CONFIG.deploy!.project,
        projectId
      })
      .handlePostDeploy({projectId, deployId, status: 500})
      .start();
    const effects = new MockDeployEffects({deployConfig: {projectId}}).addIoResponse(
      /Deploy message: /,
      "fix some bugs"
    );

    try {
      await deploy({config: TEST_CONFIG}, effects);
      fail("Should have thrown an error");
    } catch (error) {
      assert.ok(isHttpError(error));
      assert.equal(error.statusCode, 500);
    }

    effects.close();
  });

  it("throws an error if file upload fails", async () => {
    const projectId = "project123";
    const deployId = "deploy456";
    getCurentObservableApi()
      .handleGetProject({
        workspaceLogin: TEST_CONFIG.deploy!.workspace,
        projectSlug: TEST_CONFIG.deploy!.project,
        projectId
      })
      .handlePostDeploy({projectId, deployId})
      .handlePostDeployFile({deployId, status: 500})
      .start();
    const effects = new MockDeployEffects({deployConfig: {projectId}}).addIoResponse(
      /Deploy message: /,
      "fix some bugs"
    );

    try {
      await deploy({config: TEST_CONFIG}, effects);
      fail("Should have thrown an error");
    } catch (error) {
      assert.ok(isHttpError(error));
      assert.equal(error.statusCode, 500);
    }

    effects.close();
  });

  it("throws an error if deploy uploaded fails", async () => {
    const projectId = "project123";
    const deployId = "deploy456";
    getCurentObservableApi()
      .handleGetProject({
        workspaceLogin: TEST_CONFIG.deploy!.workspace,
        projectSlug: TEST_CONFIG.deploy!.project,
        projectId
      })
      .handlePostDeploy({projectId, deployId})
      .handlePostDeployFile({deployId, repeat: EXTRA_FILES.length + 1})
      .handlePostDeployUploaded({deployId, status: 500})
      .start();
    const effects = new MockDeployEffects({deployConfig: {projectId}}).addIoResponse(
      /^Deploy message: /,
      "fix some bugs"
    );

    try {
      await deploy({config: TEST_CONFIG}, effects);
      fail("Should have thrown an error");
    } catch (error) {
      assert.ok(isHttpError(error));
      assert.equal(error.statusCode, 500);
    }

    effects.close();
  });

  it("throws an error when a deploy target is not configured", async () => {
    const config = {...TEST_CONFIG, deploy: null};
    const effects = new MockDeployEffects();
    try {
      await deploy({config}, effects);
      assert.fail("expected error");
    } catch (err) {
      CliError.assert(err, {message: /You haven't configured a project to deploy to/});
    }
  });

  describe("when deploy state doesn't match", () => {
    it("interactive, when the user chooses to update", async () => {
      const newProjectId = "newProjectId";
      const deployId = "deployId";
      getCurentObservableApi()
        .handleGetProject({
          workspaceLogin: TEST_CONFIG.deploy!.workspace,
          projectSlug: TEST_CONFIG.deploy!.project,
          projectId: newProjectId
        })
        .handlePostDeploy({projectId: newProjectId, deployId})
        .handlePostDeployFile({deployId, repeat: EXTRA_FILES.length + 1})
        .handlePostDeployUploaded({deployId})
        .start();
      const effects = new MockDeployEffects({deployConfig: {projectId: "oldProjectId"}, isTty: true})
        .addIoResponse(/Do you want to deploy anyway\?/, "y")
        .addIoResponse(/^Deploy message: /, "deploying to re-created project");
      await deploy({config: TEST_CONFIG}, effects);
      effects.logger.assertAtLeastLogs([/This project was last deployed/]);
      effects.close();
    });

    it("interactive, when the user chooses not to update", async () => {
      const newProjectId = "newId";
      getCurentObservableApi()
        .handleGetProject({
          workspaceLogin: TEST_CONFIG.deploy!.workspace,
          projectSlug: TEST_CONFIG.deploy!.project,
          projectId: newProjectId
        })
        .start();
      const effects = new MockDeployEffects({deployConfig: {projectId: "oldProjectId"}, isTty: true}).addIoResponse(
        /Do you want to deploy anyway\?/,
        "n"
      );
      try {
        await deploy({config: TEST_CONFIG}, effects);
        assert.fail("expected error");
      } catch (error) {
        CliError.assert(error, {message: "User cancelled deploy", print: false, exitCode: 0});
      }
      effects.logger.assertExactLogs([/This project was last deployed/]);
      effects.close();
    });

    it("non-interactive", async () => {
      const newProjectId = "newId";
      getCurentObservableApi()
        .handleGetProject({
          workspaceLogin: TEST_CONFIG.deploy!.workspace,
          projectSlug: TEST_CONFIG.deploy!.project,
          projectId: newProjectId
        })
        .start();
      const effects = new MockDeployEffects({deployConfig: {projectId: "oldProjectId"}, isTty: false, debug: true});
      try {
        await deploy({config: TEST_CONFIG}, effects);
        assert.fail("expected error");
      } catch (error) {
        CliError.assert(error, {message: "Cancelling deploy due to misconfiguration."});
      }
      effects.logger.assertExactLogs([/This project was last deployed/]);
    });
  });
});

describe("promptConfirm", () => {
  it("should return true when the user answers y", async () => {
    const effects = new MockDeployEffects({isTty: true}).addIoResponse(/continue/, "y");
    assert.equal(await promptConfirm(effects, "continue?", {default: false}), true);
    effects.close();
  });
  it("should return false when the user answers n", async () => {
    const effects = new MockDeployEffects({isTty: true}).addIoResponse(/continue/, "n");
    assert.equal(await promptConfirm(effects, "continue?", {default: true}), false);
    effects.close();
  });
  it("should return the default when the user preses enter", async () => {
    const effects = new MockDeployEffects({isTty: true}).addIoResponse(/continue/, "").addIoResponse(/continue/, "");
    assert.equal(await promptConfirm(effects, "continue?", {default: true}), true);
    assert.equal(await promptConfirm(effects, "continue?", {default: false}), false);
    effects.close();
  });
});
