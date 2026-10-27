export function privateArtifactUrl(base: string, value: string, origin: string): string | null {
  try {
    const url = new URL(value, origin);
    return url.origin === origin &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.pathname.startsWith(base + "/")
      ? url.pathname + url.search
      : null;
  } catch {
    return null;
  }
}
