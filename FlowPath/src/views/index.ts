import type { FlowRenderer } from "../host";
import type { ViewMode } from "../types";
import { ColumnsRenderer } from "./columns";
import { FocusRenderer } from "./focus";
import { MapRenderer } from "./map";
import { OutlineRenderer } from "./outline";

export function createRenderer(mode: ViewMode): FlowRenderer {
  switch (mode) {
    case "focus":
      return new FocusRenderer();
    case "outline":
      return new OutlineRenderer();
    case "columns":
      return new ColumnsRenderer();
    default:
      return new MapRenderer();
  }
}
