export type TableRow = string[];

export type TableOptions = {
  headers?: string[];
  borders?: boolean;
  padding?: number;
};

// Simple ASCII table formatter with optional borders
export function formatTable(
  rows: TableRow[],
  options: TableOptions = {},
): string[] {
  if (rows.length === 0) return [];

  const { headers, borders = false, padding = 1 } = options;
  const allRows = headers ? [headers, ...rows] : rows;
  const columnCount = allRows[0]?.length ?? 0;

  if (columnCount === 0) return [];

  // Calculate column widths based on content
  const colWidths: number[] = Array(columnCount).fill(0);
  for (const row of allRows) {
    for (let i = 0; i < row.length; i++) {
      colWidths[i] = Math.max(colWidths[i], row[i]?.length ?? 0);
    }
  }

  const lines: string[] = [];

  if (borders) {
    lines.push(createBorderLine(colWidths, "top", padding));
  }

  // Add header if present
  if (headers) {
    lines.push(createRow(headers, colWidths, padding));
    if (borders) {
      lines.push(createBorderLine(colWidths, "mid", padding));
    } else {
      lines.push(createRow(Array(columnCount).fill(""), colWidths, padding).replace(/\S/g, "─"));
    }
  }

  // Add data rows
  for (let i = 0; i < rows.length; i++) {
    lines.push(createRow(rows[i], colWidths, padding));
  }

  if (borders) {
    lines.push(createBorderLine(colWidths, "bottom", padding));
  }

  return lines;
}

function createRow(row: TableRow, colWidths: number[], padding: number): string {
  const cells = row.map((cell, i) => {
    const padded = cell.padEnd(colWidths[i], " ");
    return " ".repeat(padding) + padded + " ".repeat(padding);
  });
  return cells.join("│").trim();
}

function createBorderLine(
  colWidths: number[],
  position: "top" | "mid" | "bottom",
  padding: number,
): string {
  const cornerL = position === "top" ? "┌" : position === "mid" ? "├" : "└";
  const cornerR = position === "top" ? "┐" : position === "mid" ? "┤" : "┘";
  const junction = position === "top" ? "┬" : position === "mid" ? "┼" : "┴";
  const line = "─";

  const cells = colWidths.map((width) => {
    const pad = " ".repeat(padding);
    return pad + line.repeat(width) + pad;
  });

  return cornerL + cells.join(junction) + cornerR;
}

// Simpler version: minimal padding format (no borders)
export function formatTableMinimal(
  rows: TableRow[],
  headers?: string[],
): string[] {
  if (rows.length === 0) return [];

  const allRows = headers ? [headers, ...rows] : rows;
  const columnCount = allRows[0]?.length ?? 0;

  if (columnCount === 0) return [];

  // Calculate column widths
  const colWidths: number[] = Array(columnCount).fill(0);
  for (const row of allRows) {
    for (let i = 0; i < row.length; i++) {
      colWidths[i] = Math.max(colWidths[i], row[i]?.length ?? 0);
    }
  }

  const lines: string[] = [];

  // Add header if present
  if (headers) {
    lines.push(
      headers
        .map((h, i) => h.padEnd(colWidths[i], " "))
        .join("  ")
        .trimEnd(),
    );
    lines.push(
      colWidths
        .map((w) => "─".repeat(w))
        .join("  ")
        .trimEnd(),
    );
  }

  // Add data rows
  for (const row of rows) {
    lines.push(
      row
        .map((cell, i) => cell.padEnd(colWidths[i], " "))
        .join("  ")
        .trimEnd(),
    );
  }

  return lines;
}
