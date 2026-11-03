"use client";

import {
  type ColumnDef,
  createColumnHelper,
  createSortedRowModel,
  type RowData,
  type RowSelectionState,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";

export type { RowSelectionState };

// Kept at module scope: Table rebuilds its row models whenever features or columns change.
const features = tableFeatures({
  rowSortingFeature,
  rowSelectionFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    basic: sortFn_basic,
    datetime: sortFn_datetime,
    text: sortFn_text,
  },
  // `className` goes on the column's header and cells: "text-right tabular-nums" lines numbers
  // up, and "hidden @2xl:table-cell" shows a column only once the table itself is 672 px wide.
  // The table's width, not the window's: from 768 px the sidebar takes 240 px of it.
  columnMeta: {} as { className?: string },
});
type Features = typeof features;

/** Typed column builders for a table of `T`. */
export const columnsFor = <T extends RowData>() => createColumnHelper<Features, T>();

const icon = { "aria-hidden": true, size: 16, strokeWidth: 1.5 } as const;

// A checkbox keeps a 44 px target at phone width, inside a 36 px row from 768 px.
const boxCell =
  "inline-flex min-h-[44px] min-w-[44px] items-center justify-center accent-ink md:min-h-0";

/**
 * A dense table: 36 px rows, headers that sort when pressed, and one menu per row at the end.
 * With `selection`, a first column of checkboxes selects rows by id. `columns` must be stable
 * (module scope or memoized).
 */
export function DataTable<T extends { id: string }>({
  label,
  data,
  columns,
  actions,
  selection,
}: {
  label: string;
  data: T[];
  columns: ColumnDef<Features, T>[];
  actions?: (row: T) => ReactNode;
  selection?: {
    selected: RowSelectionState;
    onChange: (next: RowSelectionState) => void;
    /** Names the row's checkbox: "Select {name}". */
    nameOf: (row: T) => string;
  };
}) {
  const table = useTable({
    features,
    columns,
    data,
    getRowId: (row) => row.id,
    ...(selection && {
      state: { rowSelection: selection.selected },
      onRowSelectionChange: (next) =>
        selection.onChange(typeof next === "function" ? next(selection.selected) : next),
    }),
  });
  const all = table.getIsAllRowsSelected();
  const some = table.getIsSomeRowsSelected();
  return (
    <div className="@container mt-4 overflow-x-auto rounded-xl border border-mist bg-surface">
      <table className="w-full text-[14px]">
        <caption className="sr-only">{label}</caption>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id} className="border-b border-mist text-left text-graphite">
              {selection && (
                <th scope="col" className="w-11 pl-2">
                  <label className={boxCell}>
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={all}
                      ref={(box) => {
                        if (box) box.indeterminate = some && !all;
                      }}
                      onChange={table.getToggleAllRowsSelectedHandler()}
                      disabled={data.length === 0}
                    />
                  </label>
                </th>
              )}
              {group.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={
                      sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined
                    }
                    className={`h-9 whitespace-nowrap px-4 font-semibold ${header.column.columnDef.meta?.className ?? ""}`}
                  >
                    {header.isPlaceholder ? null : header.column.getCanSort() ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex min-h-[44px] items-center gap-1 font-semibold hover:underline md:min-h-0"
                      >
                        <table.FlexRender header={header} />
                        {sorted === "asc" && <ArrowUp {...icon} />}
                        {sorted === "desc" && <ArrowDown {...icon} />}
                      </button>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </th>
                );
              })}
              {actions && (
                <th scope="col" className="w-12">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="h-9 border-b border-mist last:border-b-0">
              {selection && (
                <td className="pl-2">
                  <label className={boxCell}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${selection.nameOf(row.original)}`}
                      checked={row.getIsSelected()}
                      onChange={row.getToggleSelectedHandler()}
                    />
                  </label>
                </td>
              )}
              {row.getAllCells().map((cell) => (
                <td
                  key={cell.id}
                  className={`px-4 py-1 ${cell.column.columnDef.meta?.className ?? ""}`}
                >
                  <table.FlexRender cell={cell} />
                </td>
              ))}
              {actions && <td className="px-2 py-0.5 text-right">{actions(row.original)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
