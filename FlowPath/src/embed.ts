// ```flowpath``` code blocks: a live chart inside a note.
import { MarkdownRenderChild, Menu, TFile, setIcon, type MarkdownPostProcessorContext } from "obsidian";
import type FlowPathPlugin from "./main";
import { FlowController } from "./controller";
import { parseEmbedSource, type EmbedSpec } from "./links";
import { modeSwitcher } from "./ui";

export function resolveChartFile(plugin: FlowPathPlugin, value: string, sourcePath: string): TFile | null {
  const app = plugin.app;
  const tries = [value, value + ".flowpath"];
  for (const t of tries) {
    const f = app.vault.getAbstractFileByPath(t);
    if (f instanceof TFile && f.extension === "flowpath") return f;
  }
  for (const t of tries) {
    const f = app.metadataCache.getFirstLinkpathDest(t, sourcePath);
    if (f && f.extension === "flowpath") return f;
  }
  const base = value.replace(/\.flowpath$/, "").toLowerCase();
  return plugin.store.chartFiles().find((f) => f.basename.toLowerCase() === base) ?? null;
}

class EmbedChild extends MarkdownRenderChild {
  private controller: FlowController | null = null;

  constructor(el: HTMLElement, private plugin: FlowPathPlugin, private spec: EmbedSpec, private sourcePath: string) {
    super(el);
  }

  async onload(): Promise<void> {
    const el = this.containerEl;
    el.empty();
    const spec = this.spec;
    if (!spec.chart) {
      el.createDiv({ cls: "fp-embed-error", text: "flowpath block needs a line like  chart: My Chart" });
      return;
    }
    const file = resolveChartFile(this.plugin, spec.chart, this.sourcePath);
    if (!file) {
      el.createDiv({ cls: "fp-embed-error", text: `Flow chart not found: ${spec.chart}` });
      return;
    }

    const card = el.createDiv({ cls: "fp-embed" });
    const head = card.createDiv({ cls: "fp-embed-head" });
    const title = head.createDiv({ cls: "fp-embed-title" });
    head.createDiv({ cls: "fp-spacer" });
    const body = card.createDiv({ cls: "fp-embed-body" });
    body.style.height = `${spec.height}px`;

    const c = new FlowController(this.plugin, file, body, this, {
      compact: true,
      mode: spec.view,
      node: spec.node,
      persist: false,
      onChange: () => {
        title.empty();
        title.createSpan({ cls: "fp-embed-chart", text: c.chart.title });
        if (c.current !== c.chart.root) {
          title.createSpan({ cls: "fp-embed-dot", text: "·" });
          title.createSpan({ cls: "fp-embed-node", text: c.chart.nodes[c.current]?.title ?? "" });
        }
        sw.set(c.mode);
      },
    });
    this.controller = c;
    const sw = modeSwitcher(head, spec.view, (m) => c.setMode(m), false);
    if (this.plugin.settings.embedOpenButton) {
      const label = this.plugin.settings.openInWindow ? "Open in separate window" : "Open in tab";
      const open = head.createEl("button", { cls: "fp-icon-btn", attr: { "aria-label": `${label} (right-click for more)`, type: "button" } });
      setIcon(open, "external-link");
      open.addEventListener("click", () => void this.plugin.openNode(file, c.current, { mode: c.mode }));
    }
    // Right-click on the embed's header bar (the chart area has its own menu).
    this.registerDomEvent(head, "contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = new Menu();
      this.plugin.addOpenItems(menu, file, { node: c.current, mode: c.mode, inPopout: c.inPopout });
      menu.showAtMouseEvent(e);
    });
    await c.load();
  }

  onunload(): void {
    this.controller?.destroy();
    this.controller = null;
  }
}

export function registerEmbed(plugin: FlowPathPlugin): void {
  plugin.registerMarkdownCodeBlockProcessor("flowpath", (src: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
    ctx.addChild(new EmbedChild(el, plugin, parseEmbedSource(src), ctx.sourcePath));
  });
}
