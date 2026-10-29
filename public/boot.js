// Independent of module imports so a broken/missing module produces visible feedback.
(() => {
  const status = document.querySelector('#startup-status');
  const form = document.querySelector('#login-form');
  const button = form.querySelector('[type=submit]');
  let ready = status.hidden;
  const showFailure = () => {
    if (ready) return;
    status.hidden = false;
    status.textContent = 'The sign-in scripts could not load. Stop the old server with Ctrl+C, run npm start from this project folder, then reload the page. If using MySQL, run npm run db:migrate before restarting.';
    button.disabled = true;
  };
  form.addEventListener('submit', event => {
    if (!ready) { event.preventDefault(); showFailure(); }
  });
  window.addEventListener('convo-ready', () => { ready = true; status.hidden = true; button.disabled = false; });
  window.addEventListener('error', event => {
    if (event.target?.tagName === 'SCRIPT' || event.filename?.endsWith('/app.js')) showFailure();
  }, true);
  setTimeout(showFailure, 8000);
})();
