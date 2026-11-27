// Shape of a .flowpath file (JSON). Keep this stable: links in notes point at
// chart.id + node.id, so ids must never be regenerated for existing data.

export type NodeColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple";
export const NODE_COLORS: NodeColor[] = ["red", "orange", "yellow", "green", "blue", "purple"];

export interface FlowNode {
  id: string;
  title: string;
  /** Short markdown shown on the node's card / focus panel. */
  desc?: string;
  /** Linked note: a vault path ("A/B/B.md") or a linkpath ("B"), resolved against the chart file. */
  note?: string;
  color?: NodeColor;
  /** Checked off while following the chart. */
  done?: boolean;
}

/** A directed edge: `to` is one of the options that follow `from`. Order in Chart.edges is option order. */
export interface FlowEdge {
  from: string;
  to: string;
  /** Optional text on the arrow, e.g. "found creds" or "next phase". */
  label?: string;
}

export interface Chart {
  version: 1;
  /** Stable chart id, used by links so renaming/moving the file never breaks them. */
  id: string;
  title: string;
  /** Start node. */
  root: string;
  nodes: Record<string, FlowNode>;
  edges: FlowEdge[];
}

export type ViewMode = "map" | "focus" | "outline" | "columns";
export const VIEW_MODES: ViewMode[] = ["map", "focus", "outline", "columns"];

export type Direction = "TB" | "LR";
