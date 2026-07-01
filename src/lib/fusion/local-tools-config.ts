function configuredRootLabels() {
  const configured = (process.env.FUSION_LOCAL_ROOTS ?? "")
    .split(/[,\n]/)
    .map((root) => root.trim())
    .filter(Boolean);

  if (configured.length > 0) {
    return configured;
  }

  return [".", "~/Desktop", "~/Downloads"];
}

export function hasLocalTools() {
  return process.env.FUSION_LOCAL_TOOLS !== "0" && configuredRootLabels().length > 0;
}

export function localToolRootLabels() {
  return configuredRootLabels();
}
