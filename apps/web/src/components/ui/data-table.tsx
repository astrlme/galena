"use client";

import {
  type ColumnDef,
  createColumnHelper,
  createSortedRowModel,
  type RowData,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";

// Kept at module scope: Table rebuilds its row models whenever features or columns change.
const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, datetime: sortFn_datetime, text: sortFn_text },
});
type Features = typeof features;

/** Typed column builders for a table of `T`. */
export const columnsFor = <T extends RowData>() => createColumnHelper<Features, T>();

const icon = { "aria-hidden": true, size: 14, strokeWidth: 1.5 } as const;

/**
 * A dense table: 36 px rows, headers that sort when pressed, and one menu per row at the end.
 * `columns` must be stable (module scope or memoized).
 */
export function DataTable<T extends { id: string }>({
  label,
  data,
  columns,
  actions,
}: {
  label: string;
  data: T[];
  columns: ColumnDef<Features, T>[];
  actions?: (row: T) => ReactNode;
}) {
  const table = useTable({ features, columns, data, getRowId: (row) => row.id });
  return (
    <div className="mt-4 overflow-x-auto rounded-xl border border-mist bg-surface">
      <table className="w-full text-[14px]">
        <caption className="sr-only">{label}</caption>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id} className="border-b border-mist text-left text-graphite">
              {group.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={
                      sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined
                    }
                    className="h-9 whitespace-nowrap px-4 font-semibold"
                  >
                    {header.isPlaceholder ? null : header.column.getCanSort() ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex items-center gap-1 font-semibold hover:underline"
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
              {row.getAllCells().map((cell) => (
                <td key={cell.id} className="px-4 py-1">
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
