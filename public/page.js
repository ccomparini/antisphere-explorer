// What every page shows besides its view: a failure, in place of the page,
// and short notes that clear themselves. The raycast page, the editor,
// physlab and the anim viewer each run their main() through runPage().

/**
 * Run a page's `main()`. If it throws, its message is shown in #err in
 * place of the page - `hide`, the element to hide (the canvas, or the whole
 * app) - and thrown on, for the console: the promise returned rejects.
 */
export function runPage(main, { hide }) {
  return main().catch((error) => {
    const err = document.getElementById('err');
    err.textContent = error.message;
    err.hidden = false;
    err.style.display = 'grid';
    hide.style.display = 'none';
    throw error;
  });
}

/**
 * A note line in `element`: note(text, bad) shows text, green, or red if
 * bad, and clears it after a moment - longer for something gone wrong.
 */
export function noteIn(element) {
  let timer = 0;
  return (text, bad) => {
    element.textContent = text;
    element.style.color = bad ? '#f87171' : '#4ade80';
    clearTimeout(timer);
    timer = setTimeout(() => { element.textContent = ''; }, bad ? 6000 : 1600);
  };
}
