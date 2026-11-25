import { View, div } from "gpui-kit";
import { checking, closeOverlay, props, run, shared } from "herdr";

// Another layout starts its mods fresh, and so does coming back: chrome mods don't reload on save otherwise.
export default class LayoutReload extends View {
  init(_props, cx) {
    if (checking()) return;
    const name = shared("layout");
    if (!name) return closeOverlay(props().overlay);
    run("layout.switch");
    cx.timer.after(250, () => {
      run("layout.switch", { name });
      closeOverlay(props().overlay);
    });
  }

  render() {
    return div();
  }
}
