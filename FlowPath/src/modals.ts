// Promise-returning modals. Every ask resolves to null when dismissed.
import { FuzzySuggestModal, Modal, type App } from "obsidian";
import type { OutlineMode } from "./model";

function openModal<T>(app: App, title: string, build: (m: Modal, done: (v: T | null) => void) => void): Promise<T | null> {
  return new Promise((resolve) => {
    const m = new Modal(app);
    let settled = false;
    const settle = (v: T | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const done = (v: T | null) => {
      settle(v);
      m.close();
    };
    m.modalEl.addClass("fp-modal");
    m.titleEl.setText(title);
    m.onClose = () => {
      m.contentEl.empty();
      settle(null);
    };
    build(m, done);
    m.open();
  });
}

function buttons(m: Modal, cta: string, onOk: () => void, onCancel: () => void, danger = false): void {
  const row = m.contentEl.createDiv({ cls: "fp-modal-buttons" });
  row.createEl("button", { text: "Cancel" }).addEventListener("click", onCancel);
  const ok = row.createEl("button", { text: cta, cls: danger ? "mod-warning" : "mod-cta" });
  ok.addEventListener("click", onOk);
}

export function promptText(app: App, o: { title: string; value?: string; placeholder?: string; cta?: string; description?: string; allowEmpty?: boolean }): Promise<string | null> {
  return openModal<string>(app, o.title, (m, done) => {
    if (o.description) m.contentEl.createEl("p", { text: o.description, cls: "fp-modal-desc" });
    const input = m.contentEl.createEl("input", { type: "text", cls: "fp-input", attr: { placeholder: o.placeholder ?? "" } });
    input.value = o.value ?? "";
    const submit = () => {
      const v = input.value.trim();
      if (!v && !o.allowEmpty) return;
      done(v);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); }
    });
    buttons(m, o.cta ?? "OK", submit, () => done(null));
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

export function promptTextArea(app: App, o: { title: string; value?: string; cta?: string }): Promise<string | null> {
  return openModal<string>(app, o.title, (m, done) => {
    const ta = m.contentEl.createEl("textarea", { cls: "fp-textarea", attr: { rows: "9" } });
    ta.value = o.value ?? "";
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done(ta.value.trim()); }
    });
    m.contentEl.createEl("p", { text: "Markdown works. Ctrl+Enter to save.", cls: "fp-modal-desc" });
    buttons(m, o.cta ?? "Save", () => done(ta.value.trim()), () => done(null));
    setTimeout(() => { ta.focus(); }, 0);
  });
}

export interface ConfirmResult { checked: boolean }

export function confirm(app: App, o: { title: string; message: string; cta: string; danger?: boolean; checkbox?: string }): Promise<ConfirmResult | null> {
  return openModal<ConfirmResult>(app, o.title, (m, done) => {
    m.contentEl.createEl("p", { text: o.message });
    let box: HTMLInputElement | null = null;
    if (o.checkbox) {
      const label = m.contentEl.createEl("label", { cls: "fp-check" });
      box = label.createEl("input", { type: "checkbox" });
      label.createSpan({ text: o.checkbox });
    }
    buttons(m, o.cta, () => done({ checked: !!box?.checked }), () => done(null), o.danger);
  });
}

class Picker<T> extends FuzzySuggestModal<T> {
  chosen: T | null = null;
  constructor(app: App, private items: T[], private label: (t: T) => string, placeholder: string, private onDone: (t: T | null) => void) {
    super(app);
    this.setPlaceholder(placeholder);
    this.modalEl.addClass("fp-modal");
  }
  getItems(): T[] { return this.items; }
  getItemText(t: T): string { return this.label(t); }
  onChooseItem(t: T): void { this.chosen = t; }
  onClose(): void {
    super.onClose();
    // selection fires right after close; settle on the next tick
    setTimeout(() => this.onDone(this.chosen), 0);
  }
}

export function pick<T>(app: App, items: T[], label: (t: T) => string, placeholder: string): Promise<T | null> {
  return new Promise((resolve) => new Picker(app, items, label, placeholder, resolve).open());
}

export interface NewChartInput { title: string; folder: string }

export function askNewChart(app: App, defaultFolder: string): Promise<NewChartInput | null> {
  return openModal<NewChartInput>(app, "New flow chart", (m, done) => {
    m.contentEl.createEl("label", { text: "Title", cls: "fp-label" });
    const title = m.contentEl.createEl("input", { type: "text", cls: "fp-input", attr: { placeholder: "Attack path" } });
    m.contentEl.createEl("label", { text: "Folder", cls: "fp-label" });
    const folder = m.contentEl.createEl("input", { type: "text", cls: "fp-input" });
    folder.value = defaultFolder;
    const submit = () => {
      const t = title.value.trim();
      if (t) done({ title: t, folder: folder.value.trim().replace(/^\/+|\/+$/g, "") });
    };
    for (const i of [title, folder]) i.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); } });
    buttons(m, "Create", submit, () => done(null));
    setTimeout(() => title.focus(), 0);
  });
}

export interface OutlineInput { title: string; mode: OutlineMode }

export function askOutline(app: App, defaultTitle: string): Promise<OutlineInput | null> {
  return openModal<OutlineInput>(app, "New flow chart from list", (m, done) => {
    m.contentEl.createEl("label", { text: "Title", cls: "fp-label" });
    const title = m.contentEl.createEl("input", { type: "text", cls: "fp-input" });
    title.value = defaultTitle;
    m.contentEl.createEl("label", { text: "Top-level items are", cls: "fp-label" });
    const sel = m.contentEl.createEl("select", { cls: "dropdown fp-select" });
    sel.createEl("option", { value: "sequence", text: "Top-level items are steps in order" });
    sel.createEl("option", { value: "options", text: "Top-level items are options" });
    const submit = () => {
      const t = title.value.trim();
      if (t) done({ title: t, mode: sel.value as OutlineMode });
    };
    title.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); } });
    buttons(m, "Create", submit, () => done(null));
    setTimeout(() => { title.focus(); title.select(); }, 0);
  });
}
