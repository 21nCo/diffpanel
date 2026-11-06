/** `html` with every comment removed, such as Svelte's hydration anchors, repeating until none is left. */
export function withoutComments(html: string): string {
  let previous: string;
  let current = html;
  do {
    previous = current;
    current = current.replace(/<!--.*?-->/gs, "");
  } while (current !== previous);
  return current;
}
