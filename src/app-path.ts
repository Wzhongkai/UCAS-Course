const configuredBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const APP_BASE_PATH = configuredBasePath === "/" ? "" : configuredBasePath.replace(/\/$/, "");

export function appUrl(path: string) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${APP_BASE_PATH}${normalized}`;
}
