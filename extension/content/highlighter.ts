function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function highlightAcceptedSnippet(text: string): void {
  const needle = normalize(text).slice(0, 80);
  if (!needle) return;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    const value = node.textContent ?? "";
    const compact = normalize(value);
    if (compact.includes(needle)) {
      const el = node.parentElement;
      if (!el) return;
      el.classList.add("vcapp-hl");
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      window.setTimeout(() => el.classList.remove("vcapp-hl"), 3500);
      return;
    }
    node = walker.nextNode();
  }
}
