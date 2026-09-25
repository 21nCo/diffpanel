export const MAX_DIAGRAM_SOURCE_LENGTH = 20_000;

/** Restrict author-controlled configuration and active content before local rendering. */
export function diagramSourceError(source: string): string | null {
  if (source.length > MAX_DIAGRAM_SOURCE_LENGTH) return "Diagram is too large to render. View its source below.";
  const hasConfiguration = source.split(/[\r\n\u2028\u2029]/u).some((line) => line.trimStart().startsWith("---"));
  if (hasConfiguration || /(?:%%\{|\bclick\s|<\/?[a-z]|javascript:|https?:\/\/)/i.test(source)) {
    return "Diagram contains configuration, links, or HTML that cannot be rendered. View its source below.";
  }
  return null;
}
