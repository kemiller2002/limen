export const render = (element: HTMLElement, html: string): void => {
  element.innerHTML = html;
  element.insertAdjacentHTML("beforeend", html);
  document.write(html);
};
