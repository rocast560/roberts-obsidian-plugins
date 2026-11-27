// Contract between the view renderers (src/views/*) and whatever hosts them
// (the FlowView window/tab, or a ```flowpath``` embed inside a note).
import type { App, Component } from "obsidian";
import type { Chart, Direction, ViewMode } from "./types";

export interface MapState {
  dir: Direction;
  /** Node ids whose options are collapsed in the map. */
  collapsed: Set<string>;
  /** Current zoom (1 = 100%) and pan offset in screen pixels. NaN zoom = "not positioned yet, fit/center on first render". */
  zoom: number;
  panX: number;
  panY: number;
}

export interface FlowHost {
  readonly app: App;
  /** Live chart object. Renderers never mutate it directly; they call host methods. */
  readonly chart: Chart;
  /** Vault path of the .flowpath file. */
  readonly chartPath: string;
  /** Currently focused node id. */
  readonly current: string;
  /** True inside a note embed: smaller, fewer controls, no keyboard capture. */
  readonly compact: boolean;
  /** Map pan/zoom/collapse state. Renderers may mutate it, then call saveMapState(). */
  readonly mapState: MapState;
  /** Owner component for MarkdownRenderer and registered events. */
  readonly component: Component;

  /** Focus a node. The host re-renders (calls renderer.render again) and updates its breadcrumb. */
  select(id: string): void;
  /** Open the node's linked note in the main window (new tab if `newTab`). If it has no note, the host offers to link/create one. */
  openNote(id: string, newTab: boolean): void;
  /** Show the full node context menu (rename, add option, link note, colour, delete, copy link...). */
  showNodeMenu(id: string, evt: MouseEvent): void;
  /** Prompt for a title and add a new option under `parentId`, then select it. */
  addOption(parentId: string): void;
  /** Prompt to rename the node. */
  rename(id: string): void;
  /** Toggle node.done and save. */
  toggleDone(id: string): void;
  /** Toggle collapse of a node in the map, save map state and re-render. */
  toggleCollapse(id: string): void;
  /** Switch to another view mode (host re-renders). */
  setMode(mode: ViewMode): void;
  /** Markdown body of the linked note (frontmatter stripped, cut at ~maxChars). null if no note/unresolved. */
  noteExcerpt(id: string, maxChars?: number): Promise<string | null>;
  /** Display name of the linked note (basename), or null. */
  noteName(id: string): string | null;
  /** Render markdown with Obsidian's renderer, links working. */
  renderMarkdown(md: string, el: HTMLElement): Promise<void>;
  /** Persist mapState (debounced by the host). */
  saveMapState(): void;
}

export interface FlowRenderer {
  /**
   * (Re)draw everything into `el` (the renderer owns el's children; clear first).
   * Called on first show, after every chart change and after select().
   */
  render(el: HTMLElement, host: FlowHost): void;
  /** Optional: bring a node into view (map: animate pan to it). Called after select() from outside, e.g. a link click. */
  reveal?(id: string): void;
  /** Optional: fit the whole chart in view (map only). */
  fit?(): void;
  /** Called when the host is closed or switches mode. Remove listeners on window/document here. */
  destroy?(): void;
}
