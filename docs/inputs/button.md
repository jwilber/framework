# Button input

[API Reference ›](https://github.com/observablehq/inputs/blob/main/README.md#button)

The button input emits an *input* event when you click it. Buttons may be used to trigger the evaluation of cells, say to restart an animation.

For example, below is an animation (using [yield](../javascript/generators)) that progressively hides a bar.

```js echo
import * as Inputs from "npm:@observablehq/inputs";
```

```js echo
const width = 360;
const height = 20;
const style = "max-width: 100%; border: solid 1px black;";
```

```html
<canvas id="canvas" width="${width}" height="${height}" style="${style}">
```

```js echo
const replay = view(Inputs.button("Replay"));
const canvas = document.querySelector("#canvas");
const context = canvas.getContext("2d");
```

 The code block below references <code>replay</code>, so it will run automatically whenever the replay button is clicked. If you click the button while the animation is still running, the animation will be interrupted and restart from the beginning.

```js echo
replay;
const progress = (function* () {
  for (let i = width; i >= 0; --i) {
    context.clearRect(0, 0, width, height);
    context.fillRect(0, 0, i, height);
    yield context.canvas;
  }
})();
```

You can also use buttons to count clicks. While the value of a button is often not needed, it defaults to zero and is incremented each time the button is clicked.

```js echo
const clicks = view(Inputs.button("Click me"));
```

```js echo
clicks
```

Interpolate input values into Markdown using [inline expressions](../javascript#inline-expressions):

You have clicked ${clicks} times. 

```md
You have clicked ${clicks} times.
```

You can change this behavior by specifying the *value* and *reduce* options: *value* is the initial value, and *reduce* is called whenever the button is clicked, being passed the current value and returning the new value. The value of the button below is the last time the button was clicked, or null if the button has not been clicked.

```js echo
const time = view(Inputs.button("Update", {value: null, reduce: () => new Date}));
```

```js
time
```

Note that even if the value of the button doesn’t change, it will still trigger any cells that reference the button’s value to run. (The Observable runtime listens for *input* events on the view, and doesn’t check whether the value of the view has changed.)

For multiple buttons, pass an array of [*content*, *reduce*] tuples. For example, to have a counter that can be incremented, decremented, and reset:

```js echo
const counter = view(Inputs.button([
  ["Increment", value => value + 1],
  ["Decrement", value => value - 1],
  ["Reset", value => 0]
], {value: 0, label: "Counter"}));
```

```js echo
counter
```

The first argument to `Inputs.button()` is the contents of the button. It’s not required, but it’s strongly encouraged.

```js echo
const x = view(Inputs.button());
```

The contents of the button input can be an HTML element if desired, say for control over typography.

```js echo
const y = view(Inputs.button(html`<i>Fancy</i>`));
```

Like other basic inputs, buttons can have an optional label, which can also be either a text string or an HTML element.

```js echo
const confirm = view(Inputs.button("OK", {label: "Continue?"}));
```

You can change the rendered text in Markdown based on whether a button is clicked. Try clicking the `OK` button with the  `Continue?` label.

```md echo run=false
confirm ? "Confirmed!" : "Awaiting confirmation..."
```

${confirm ? "Confirmed!" : "Awaiting confirmation..."}

You can also use a button to copy something to the clipboard.

```js echo
Inputs.button("Copy to clipboard", {value: null, reduce: () => navigator.clipboard.writeText(time)})
```

## Options

**Inputs.button(*content*, *options*)**

The available button input options are:

* *label* - a label; either a string or an HTML element.
* *required* - if true, the initial value defaults to undefined.
* *value* - the initial value; defaults to 0 or null if *required* is false.
* *reduce* - a function to update the value on click; by default returns *value* + 1.
* *width* - the width of the input (not including the label).
* *disabled* - whether input is disabled; defaults to false.