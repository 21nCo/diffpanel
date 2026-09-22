export function npmTagForVersion(version) {
  return version.split("+", 1)[0].includes("-") ? "next" : "latest";
}
