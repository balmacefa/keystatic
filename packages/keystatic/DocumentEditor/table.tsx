import { ContextType, createContext, useContext, useMemo } from 'react';
import {
  Descendant,
  Editor,
  Element,
  Node,
  Path,
  Transforms,
  Range,
  Text as SlateText,
  Point,
} from 'slate';
import { ReactEditor, RenderElementProps, useSlate } from 'slate-react';

import { ActionButton } from '@voussoir/button';
import { tableIcon } from '@voussoir/icon/icons/tableIcon';
import { Icon } from '@voussoir/icon';
import { TooltipTrigger, Tooltip } from '@voussoir/tooltip';
import { Text } from '@voussoir/typography';

import { useToolbarState } from './toolbar-state';
import { css, tokenSchema } from '@voussoir/style';
import { nodeTypeMatcher, useStaticEditor } from './utils';
import { chevronDownIcon } from '@voussoir/icon/icons/chevronDownIcon';
import { Item, Menu, MenuTrigger } from '@voussoir/menu';
import weakMemoize from '@emotion/weak-memoize';

const cell = () => ({
  type: 'table-cell' as const,
  children: [{ type: 'paragraph' as const, children: [{ text: '' }] }],
});

export const insertTable = (editor: Editor) => {
  Transforms.insertNodes(editor, {
    type: 'table',
    children: [
      {
        type: 'table-body',
        children: [
          { type: 'table-row', children: [cell(), cell(), cell()] },
          { type: 'table-row', children: [cell(), cell(), cell()] },
          { type: 'table-row', children: [cell(), cell(), cell()] },
        ],
      },
    ],
  });
};

function cloneDescendant(node: Descendant): Descendant {
  if (SlateText.isText(node)) return { ...node };
  return {
    ...node,
    children: node.children.map(cloneDescendant),
  };
}

function calculateRowSize(row: Element): number {
  return row.children.reduce(
    (acc, cell) =>
      acc +
      (cell.type === 'table-cell' && typeof cell.colSpan === 'number'
        ? cell.colSpan
        : 1),
    0
  );
}

export function withTable(editor: Editor): Editor {
  const { deleteFragment, normalizeNode, getFragment, insertFragment } = editor;
  editor.insertFragment = fragment => {
    const selectedTableArea = getSelectedTableArea(editor);
    if (
      !selectedTableArea ||
      fragment.length !== 1 ||
      fragment[0].type !== 'table' ||
      fragment[0].children[0].type !== 'table-body' ||
      selectedTableArea.table.children[0].type !== 'table-body'
    ) {
      insertFragment(fragment);
      return;
    }
    const newRows = fragment[0].children[0].children;
    let { row, column, tablePath } = selectedTableArea;
    const existingBody = selectedTableArea.table.children[0];
    if (
      newRows[0].type !== 'table-row' ||
      existingBody.children[0].type !== 'table-row'
    ) {
      insertFragment(fragment);
      return;
    }
    if (selectedTableArea.singleCell !== 'many') {
      row = {
        start: row.start,
        end: Math.min(
          row.start + newRows.length - 1,
          existingBody.children.length - 1
        ),
      };
      column = {
        start: column.start,
        end: Math.min(
          column.start + newRows[0].children.length - 1,
          existingBody.children[0].children.length - 1
        ),
      };
    }
    Editor.withoutNormalizing(editor, () => {
      for (let rowIndex = row.start; rowIndex <= row.end; rowIndex++) {
        const existingRow = existingBody.children[rowIndex];
        const newRow = newRows[(rowIndex - row.start) % newRows.length];
        if (!Element.isElement(existingRow) || !Element.isElement(newRow)) {
          continue;
        }
        for (
          let cellIndex = column.start;
          cellIndex <= column.end;
          cellIndex++
        ) {
          const cell = existingRow.children[cellIndex];
          const newCell =
            newRow.children[
              (cellIndex - column.start) % newRow.children.length
            ];
          if (!Element.isElement(cell) || !Element.isAncestor(newCell)) {
            continue;
          }
          const cellPath = [...tablePath, 0, rowIndex, cellIndex];
          for (const childIdx of [...cell.children.keys()].reverse()) {
            Transforms.removeNodes(editor, {
              at: [...cellPath, childIdx],
            });
          }
          Transforms.insertNodes(
            editor,
            newCell.children.map(cloneDescendant),
            { at: [...cellPath, 0] }
          );
        }
      }
      Transforms.setSelection(editor, {
        anchor: Editor.start(editor, [
          ...tablePath,
          0,
          row.start,
          column.start,
        ]),
        focus: Editor.end(editor, [...tablePath, 0, row.end, column.end]),
      });
    });
  };
  editor.getFragment = () => {
    const selectedTableArea = getSelectedTableArea(editor);
    if (
      selectedTableArea &&
      selectedTableArea.singleCell !== 'not-selected' &&
      selectedTableArea.table.children[0].type === 'table-body'
    ) {
      const tableBody = selectedTableArea.table.children[0];
      return [
        {
          type: 'table',
          children: [
            {
              type: 'table-body',
              children: Array.from({
                length:
                  selectedTableArea.row.end - selectedTableArea.row.start + 1,
              }).map((_, rowIndex) => ({
                type: 'table-row',
                children: Array.from({
                  length:
                    selectedTableArea.column.end -
                    selectedTableArea.column.start +
                    1,
                }).map(
                  (_, columnIndex) =>
                    (
                      tableBody.children[
                        rowIndex + selectedTableArea.row.start
                      ] as Element
                    ).children[columnIndex + selectedTableArea.column.start]
                ),
              })),
            },
          ],
        },
      ];
    }
    return getFragment();
  };
  editor.deleteFragment = direction => {
    if (!editor.selection || Range.isCollapsed(editor.selection)) {
      deleteFragment(direction);
      return;
    }
    const selectedTableArea = getSelectedTableArea(editor);
    if (!selectedTableArea || selectedTableArea.singleCell === 'not-selected') {
      deleteFragment(direction);
      return;
    }
    const body = selectedTableArea.table.children[0];
    if (!Element.isElement(body) || !Element.isElement(body.children[0])) {
      deleteFragment(direction);
      return;
    }
    const { row, column, tablePath } = selectedTableArea;
    // note the fact that hasWholeColumnSelected uses row and hasWholeRowSelected uses column
    // is not a mistake. if a whole column has been selected, then the starting row is 0 and the end is the last row
    const hasWholeColumnSelected =
      row.start === 0 && row.end === body.children.length - 1;
    const hasWholeRowSelected =
      column.start === 0 && column.end === body.children[0].children.length - 1;
    if (hasWholeColumnSelected && hasWholeRowSelected) {
      Transforms.removeNodes(editor, { at: tablePath });
      return;
    }

    if (hasWholeRowSelected) {
      Editor.withoutNormalizing(editor, () => {
        for (let i = row.end; i >= row.start; i--) {
          Transforms.removeNodes(editor, {
            at: [...tablePath, 0, i],
          });
        }
      });
      return;
    }

    if (hasWholeColumnSelected) {
      Editor.withoutNormalizing(editor, () => {
        for (let i = column.end; i >= column.start; i--) {
          for (const rowIdx of [...body.children.keys()].reverse()) {
            Transforms.removeNodes(editor, {
              at: [...tablePath, 0, rowIdx, i],
            });
          }
        }
        const selectionPath = [...tablePath, 0, 0, column.start];
        const point = Editor.start(
          editor,
          column.start === 0 ? selectionPath : Path.previous(selectionPath)
        );
        Transforms.select(editor, point);
      });
      return;
    }
    const selectionStart = Editor.start(editor, editor.selection).path;
    Editor.withoutNormalizing(editor, () => {
      for (let rowIndex = row.start; rowIndex <= row.end; rowIndex++) {
        const row = body.children[rowIndex];
        if (!Element.isElement(row)) continue;
        for (
          let cellIndex = column.start;
          cellIndex <= column.end;
          cellIndex++
        ) {
          const cell = row.children[cellIndex];
          if (!Element.isElement(cell)) continue;

          Transforms.insertNodes(
            editor,
            { type: 'paragraph', children: [{ text: '' }] },
            { at: [...selectedTableArea.tablePath, 0, rowIndex, cellIndex, 0] }
          );
          for (const childIdx of [...cell.children.keys()].reverse()) {
            Transforms.removeNodes(editor, {
              at: [
                ...selectedTableArea.tablePath,
                0,
                rowIndex,
                cellIndex,
                childIdx + 1,
              ],
            });
          }
        }
      }
      Transforms.select(editor, selectionStart);
    });
  };
  editor.normalizeNode = entry => {
    const [node, path] = entry;
    if (
      node.type === 'table-cell' &&
      node.colSpan !== undefined &&
      node.colSpan <= 1
    ) {
      Transforms.unsetNodes(editor, 'colSpan', { at: path });
      return;
    }
    if (node.type === 'table') {
      for (const [idx, child] of node.children.entries()) {
        if (child.type === 'table-body') {
          const maxRowCount = child.children.reduce(
            (max, node) =>
              node.type === 'table-row'
                ? Math.max(max, calculateRowSize(node))
                : max,
            0
          );
          let didInsert = false;
          for (const [rowIdx, row] of child.children.entries()) {
            if (row.type !== 'table-row') continue;
            const rowSize = calculateRowSize(row);
            if (rowSize === maxRowCount) continue;
            Transforms.insertNodes(
              editor,
              Array.from({ length: maxRowCount - rowSize }).map(cell),
              { at: [...path, idx, rowIdx, row.children.length] }
            );
            didInsert = true;
          }
          if (didInsert) {
            return;
          }
        }
      }
    }
    normalizeNode(entry);
  };
  return editor;
}

const SelectedCellsContext = createContext<
  | {
      table: Element & { type: 'table' };
      focus: Descendant;
      cells: Set<Descendant>;
    }
  | undefined
>(undefined);

function order(a: number, b: number) {
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

const getCellPointsToRelativePath = weakMemoize(
  function getCellPointsToRelativePath(
    table: Element & { type: 'table' }
  ): [number, number, number][][] {
    const tableBody = table.children[0];
    if (!Element.isElement(tableBody)) return [];
    const rows: [number, number, number][][] = [];
    for (const [rowIdx, row] of tableBody.children.entries()) {
      if (row.type !== 'table-row') return [];
      const cells: (typeof rows)[number] = [];
      for (const [cellIdx, cell] of row.children.entries()) {
        if (cell.type !== 'table-cell') return [];
        const colSpan = cell.colSpan ?? 1;
        for (let i = 0; i < colSpan; i++) {
          cells.push([0, rowIdx, cellIdx]);
        }
      }
      rows.push(cells);
    }
    return rows;
  }
);

type CellPoints = {
  row: { start: number; end: number };
  column: { start: number; end: number };
};

const getRelativePathToCellPoints = weakMemoize(
  function getRelativePathToCellPoints(
    table: Element & { type: 'table' }
  ): CellPoints[][][] {
    const tableBody = table.children[0];
    if (!Element.isElement(tableBody)) return [];
    const rows: CellPoints[][] = [];
    for (const [rowIdx, row] of tableBody.children.entries()) {
      if (row.type !== 'table-row') return [];
      const cells: (typeof rows)[number] = [];
      let prev = 0;
      for (const cell of row.children.values()) {
        if (cell.type !== 'table-cell') return [];
        cells.push({
          row: { start: rowIdx, end: rowIdx },
          column: { start: prev + 1, end: prev + (cell.colSpan ?? 1) },
        });
        prev += cell.colSpan ?? 1;
      }
      rows.push(cells);
    }
    return [rows];
  }
);

function getSelectedCells(
  table: Element & { type: 'table' },
  row: { start: number; end: number },
  column: { start: number; end: number }
) {
  const cellPointsToRelativePath = getCellPointsToRelativePath(table);
  const selectedCells = new Set<Descendant>();
  for (let rowIndex = row.start; rowIndex <= row.end; rowIndex++) {
    const row = cellPointsToRelativePath[rowIndex];
    for (let cellIndex = column.start; cellIndex <= column.end; cellIndex++) {
      const cellRelativePath = row[cellIndex];
      const cell = Node.get(table, cellRelativePath);
      if (!Element.isElement(cell)) continue;
      selectedCells.add(cell);
    }
  }
  return selectedCells;
}

function getSelectedTableArea(editor: Editor) {
  const anchor = Editor.above(editor, {
    match: nodeTypeMatcher('table-cell'),
    at: editor.selection?.anchor.path,
  })?.[1];
  const focus = Editor.above(editor, {
    match: nodeTypeMatcher('table-cell'),
    at: editor.selection?.focus.path,
  })?.[1];
  const table = Editor.above(editor, {
    match: nodeTypeMatcher('table'),
  });
  if (
    editor.selection &&
    table &&
    Element.isElement(table[0].children[0]) &&
    anchor &&
    focus &&
    Path.equals(anchor.slice(0, -3), focus.slice(0, -3))
  ) {
    const [start, end] = Editor.edges(editor, editor.selection);
    const row = order(anchor[anchor.length - 2], focus[focus.length - 2]);
    const column = order(anchor[anchor.length - 1], focus[focus.length - 1]);
    return {
      tablePath: table[1],
      table: table[0],
      singleCell: Path.equals(anchor, focus)
        ? Point.equals(Editor.start(editor, anchor), start) &&
          Point.equals(Editor.end(editor, anchor), end) &&
          !Range.isCollapsed(editor.selection)
          ? ('selected' as const)
          : ('not-selected' as const)
        : ('many' as const),
      row,
      column,
    };
  }
}

export function TableSelectionProvider(props: { children: React.ReactNode }) {
  const editor = useSlate();
  const selectedTableArea = getSelectedTableArea(editor);
  if (
    selectedTableArea &&
    selectedTableArea.table.children[0].type === 'table-body'
  ) {
    return (
      <SelectedCellsContext.Provider
        value={{
          cells:
            selectedTableArea.singleCell === 'not-selected'
              ? new Set()
              : getSelectedCells(
                  selectedTableArea.table,
                  selectedTableArea.row,
                  selectedTableArea.column
                ),
          table: selectedTableArea.table,
          focus: Editor.above(editor, {
            match: nodeTypeMatcher('table-cell'),
            at: editor.selection?.focus.path,
          })?.[0]!,
        }}
      >
        {props.children}
      </SelectedCellsContext.Provider>
    );
  }

  return (
    <SelectedCellsContext.Provider value={undefined}>
      {props.children}
    </SelectedCellsContext.Provider>
  );
}

const StartElementsContext = createContext<{
  top: Map<Element, boolean>;
  left: Map<Element, boolean>;
}>({ top: new Map(), left: new Map() });

export const TableElement = ({
  attributes,
  children,
  element,
}: RenderElementProps) => {
  const selectedCellsContext = useContext(SelectedCellsContext);
  const selectedCells =
    selectedCellsContext?.table === element ? selectedCellsContext : undefined;
  const startElements = useMemo((): ContextType<
    typeof StartElementsContext
  > => {
    const body = element.children[0];
    if (!Element.isElement(body) || !Element.isElement(body.children[0])) {
      return { top: new Map(), left: new Map() };
    }
    const top = new Map<Element, boolean>();
    const left = new Map<Element, boolean>();
    for (const [idx, cell] of body.children[0].children.entries()) {
      if (cell.type !== 'table-cell') continue;
      top.set(
        cell,
        body.children.every(
          element =>
            Element.isElement(element) &&
            selectedCells?.cells.has(element.children[idx])
        )
      );
    }
    for (const row of body.children) {
      if (row.type !== 'table-row' || row.children[0].type !== 'table-cell') {
        continue;
      }
      left.set(
        row.children[0],
        row.children.every(element => selectedCells?.cells.has(element))
      );
    }
    return { top, left };
  }, [element, selectedCells]);
  return (
    <StartElementsContext.Provider value={startElements}>
      <SelectedCellsContext.Provider value={selectedCells}>
        <table
          className={css({
            width: '100%',
            tableLayout: 'fixed',
            position: 'relative',
            borderSpacing: 0,
            borderCollapse: 'collapse',
          })}
          {...attributes}
        >
          {children}
        </table>
      </SelectedCellsContext.Provider>
    </StartElementsContext.Provider>
  );
};

export const TableBodyElement = ({
  attributes,
  children,
}: RenderElementProps) => {
  return <tbody {...attributes}>{children}</tbody>;
};

export const TableRowElement = ({
  attributes,
  children,
  element,
}: RenderElementProps) => {
  const table = useContext(SelectedCellsContext)?.table;
  return (
    <RowIndexContext.Provider value={table?.children.indexOf(element) ?? -1}>
      <tr {...attributes}>{children}</tr>
    </RowIndexContext.Provider>
  );
};

const RowIndexContext = createContext<number>(-1);

export function TableCellElement({
  attributes,
  children,
  element,
}: RenderElementProps & { element: { type: 'table-cell' } }) {
  const editor = useStaticEditor();
  const selectedCellsContext = useContext(SelectedCellsContext);
  const startElements = useContext(StartElementsContext);
  const isSelected = selectedCellsContext?.cells.has(element);
  const size = `calc(100% + 2px)`;
  return (
    <td
      colSpan={element.colSpan}
      className={css({
        border: `1px solid ${tokenSchema.color.alias.borderIdle}`,
        backgroundColor: selectedCellsContext?.cells.has(element)
          ? tokenSchema.color.alias.backgroundSelected
          : undefined,
        '& *::selection': selectedCellsContext?.cells.size
          ? { backgroundColor: 'transparent' }
          : undefined,
        position: 'relative',
        margin: 0,
        padding: 0,
      })}
      {...attributes}
    >
      {isSelected && (
        <>
          <div
            contentEditable={false}
            className={css({
              position: 'absolute',
              top: -1,
              left: -1,
              background: tokenSchema.color.alias.borderSelected,
              height: size,
              width: 1,
            })}
          />
          <div
            contentEditable={false}
            className={css({
              position: 'absolute',
              top: -1,
              right: -1,
              background: tokenSchema.color.alias.borderSelected,
              height: size,
              width: 1,
            })}
          />
          <div
            contentEditable={false}
            className={css({
              position: 'absolute',
              top: -1,
              left: -1,
              background: tokenSchema.color.alias.borderSelected,
              height: 1,
              width: size,
            })}
          />
          <div
            contentEditable={false}
            className={css({
              position: 'absolute',
              bottom: -1,
              left: -1,
              background: tokenSchema.color.alias.borderSelected,
              height: 1,
              width: size,
            })}
          />
        </>
      )}
      {startElements.top.has(element) && (
        <CellSelection
          location="top"
          selected={!!startElements.top.get(element)}
          label="Select Column"
          onClick={() => {
            const path = ReactEditor.findPath(editor, element);
            const table = Editor.above(editor, {
              match: nodeTypeMatcher('table'),
              at: path,
            });
            if (!table || !Element.isElement(table[0].children[0])) return;
            const cellIndex = path[path.length - 1];
            const endPath = [
              ...table[1],
              0,
              table[0].children[0].children.length - 1,
              cellIndex,
            ];
            Transforms.select(editor, {
              anchor: Editor.start(editor, path),
              focus: Editor.end(editor, endPath),
            });
          }}
        />
      )}
      {startElements.left.has(element) && (
        <CellSelection
          location="left"
          selected={!!startElements.left.get(element)}
          label="Select Row"
          onClick={() => {
            const path = ReactEditor.findPath(editor, element);
            Transforms.select(editor, {
              anchor: Editor.start(editor, Path.parent(path)),
              focus: Editor.end(editor, Path.parent(path)),
            });
          }}
        />
      )}
      {startElements.left.has(element) && startElements.top.has(element) && (
        <CellSelection
          location="top-left"
          selected={
            !!(
              startElements.top.get(element) && startElements.left.get(element)
            )
          }
          label="Select Table"
          onClick={() => {
            const path = ReactEditor.findPath(editor, element);
            const table = Editor.above(editor, {
              match: nodeTypeMatcher('table'),
              at: path,
            });
            if (!table) return;
            Transforms.select(editor, {
              anchor: Editor.start(editor, table[1]),
              focus: Editor.end(editor, table[1]),
            });
          }}
        />
      )}
      {selectedCellsContext?.focus === element && <CellMenu cell={element} />}
      {children}
    </td>
  );
}

const styles = {
  top: {
    top: -9,
    left: -1,
    width: 'calc(100% + 2px)',
    height: 8,
  },
  left: {
    top: -1,
    left: -9,
    width: 8,
    height: 'calc(100% + 2px)',
  },
  'top-left': {
    top: -9,
    left: -9,
    width: 8,
    height: 8,
  },
};

function CellSelection(props: {
  location: 'top' | 'left' | 'top-left';
  selected: boolean;
  onClick: () => void;
  label: string;
}) {
  const editor = useStaticEditor();
  return (
    <div contentEditable={false}>
      <button
        type="button"
        className={css(
          {
            position: 'absolute',
            margin: 0,
            padding: 0,
            background: props.selected
              ? tokenSchema.color.scale.indigo8
              : tokenSchema.color.scale.slate3,
            border: `1px solid ${
              props.selected
                ? tokenSchema.color.alias.borderSelected
                : tokenSchema.color.alias.borderIdle
            }`,
            borderBottom: props.location === 'left' ? undefined : 'none',
            borderRight: props.location === 'top' ? undefined : 'none',
          },
          styles[props.location]
        )}
        aria-label={props.label}
        onClick={() => {
          ReactEditor.focus(editor);
          props.onClick();
        }}
      />
      {props.selected &&
        (props.location === 'top' ? (
          <div
            className={css({
              position: 'absolute',
              top: -9,
              right: -1,
              background: tokenSchema.color.alias.borderSelected,
              height: 8,
              width: 1,
              zIndex: 2,
            })}
          />
        ) : (
          <div
            className={css({
              position: 'absolute',
              bottom: -1,
              left: -9,
              background: tokenSchema.color.alias.borderSelected,
              height: 1,
              width: 8,
              zIndex: 2,
            })}
          />
        ))}
    </div>
  );
}

export const cellActions = {
  deleteRow: {
    label: 'Delete row',
    action: (editor, cellPath) => {
      Transforms.removeNodes(editor, { at: Path.parent(cellPath) });
    },
  },
  deleteColumn: {
    label: 'Delete column',
    action: (editor, path) => {
      const cellIndex = path[path.length - 1];
      const tableBodyPath = path.slice(0, -2);
      const tableBody = Node.get(editor, tableBodyPath);
      if (tableBody.type !== 'table-body') return;
      Editor.withoutNormalizing(editor, () => {
        for (const idx of tableBody.children.keys()) {
          Transforms.removeNodes(editor, {
            at: [...tableBodyPath, idx, cellIndex],
          });
        }
      });
    },
  },
  insertRowBelow: {
    label: 'Insert row below',
    action: (editor, path) => {
      const tableRow = Node.get(editor, Path.parent(path));
      if (tableRow.type !== 'table-row') {
        return;
      }
      const newRowPath = [...path.slice(0, -2), path[path.length - 2] + 1];
      Transforms.insertNodes(
        editor,
        { type: 'table-row', children: tableRow.children.map(() => cell()) },
        { at: newRowPath }
      );
      Transforms.select(editor, [...newRowPath, path[path.length - 1]]);
    },
  },
  insertColumnRight: {
    label: 'Insert column right',
    action: (editor, path) => {
      const newCellIndex = path[path.length - 1] + 1;
      const tableBodyPath = path.slice(0, -2);
      const tableBody = Node.get(editor, tableBodyPath);
      if (tableBody.type !== 'table-body') return;
      Editor.withoutNormalizing(editor, () => {
        for (const idx of tableBody.children.keys()) {
          Transforms.insertNodes(editor, cell(), {
            at: [...tableBodyPath, idx, newCellIndex],
          });
        }
        Transforms.select(editor, [
          ...tableBodyPath,
          path[path.length - 2],
          newCellIndex,
        ]);
      });
    },
  },
  mergeCells: {
    label: 'Merge cells',
    action: editor => {
      const selected = getSelectedTableArea(editor);
      if (!selected) return;
      const { row, column, tablePath, table } = selected;
      const cellPointsToRelativePath = getCellPointsToRelativePath(table);
      const cellPath = [
        ...tablePath,
        ...cellPointsToRelativePath[row.start][column.start],
      ];
      const rowPath = Path.parent(cellPath);
      const cellToMerge = Node.get(editor, cellPath);
      if (cellToMerge.type !== 'table-cell') return;
      Editor.withoutNormalizing(editor, () => {
        Transforms.setNodes(
          editor,
          { colSpan: column.end - column.start + 1 },
          { at: cellPath }
        );
        let lengthOfCell = cellToMerge.children.length;
        const seenNodes = new Set();
        for (
          let cellIndex = column.end;
          cellIndex > column.start;
          cellIndex--
        ) {
          const relativePath = cellPointsToRelativePath[row.start][cellIndex];
          const node = Node.get(editor, [...tablePath, ...relativePath]);
          if (node.type !== 'table-cell' || seenNodes.has(node)) continue;
          seenNodes.add(node);

          const to = [...cellPath, lengthOfCell];
          if (
            node.children.length === 1 &&
            node.children[0].type === 'paragraph' &&
            node.children[0].children.length === 1 &&
            node.children[0].children[0].type === undefined &&
            node.children[0].children[0].text === ''
          ) {
            Transforms.removeNodes(editor, { at: [...rowPath, cellIndex] });
          } else {
            Transforms.moveNodes(editor, { at: [...rowPath, cellIndex], to });
            Transforms.unwrapNodes(editor, { at: to });
            lengthOfCell += node.children.length;
          }
        }
        Transforms.select(editor, cellPath);
      });
    },
  },
  splitCells: {
    label: 'Split cell',
    action: (editor, path) => {
      Editor.withoutNormalizing(editor, () => {
        const node = Node.get(editor, path);
        if (node.type !== 'table-cell' || node.colSpan === undefined) return;
        Transforms.unsetNodes(editor, 'colSpan', { at: path });
        Transforms.insertNodes(
          editor,
          Array.from({ length: node.colSpan - 1 }, cell),
          { at: Path.next(path) }
        );
      });
    },
  },
} satisfies Record<
  string,
  { label: string; action: (editor: Editor, cellPath: Path) => void }
>;

const _cellActions: Record<
  string,
  { label: string; action: (editor: Editor, cellPath: Path) => void }
> = cellActions;

function CellMenu(props: { cell: Element }) {
  const editor = useStaticEditor();
  return (
    <div contentEditable={false}>
      <TooltipTrigger>
        <MenuTrigger>
          <ActionButton
            prominence="low"
            UNSAFE_className={css({
              top: 4,
              right: 4,
              position: 'absolute !important' as any,
            })}
          >
            <Icon src={chevronDownIcon} />
          </ActionButton>
          <Menu
            onAction={key => {
              if (key in _cellActions) {
                _cellActions[key].action(
                  editor,
                  ReactEditor.findPath(editor, props.cell)
                );
              }
            }}
            items={Object.entries(_cellActions).map(([key, item]) => ({
              ...item,
              key,
            }))}
          >
            {item => <Item key={item.key}>{item.label}</Item>}
          </Menu>
        </MenuTrigger>
        <Tooltip>Options</Tooltip>
      </TooltipTrigger>
    </div>
  );
}

const TableButton = () => {
  const {
    editor,
    blockquote: { isDisabled, isSelected },
  } = useToolbarState();
  return useMemo(
    () => (
      <ActionButton
        prominence="low"
        isSelected={isSelected}
        isDisabled={isDisabled}
        onPress={() => {
          insertTable(editor);
          ReactEditor.focus(editor);
        }}
      >
        <Icon src={tableIcon} />
      </ActionButton>
    ),
    [editor, isDisabled, isSelected]
  );
};
export const tableButton = (
  <TooltipTrigger>
    <TableButton />
    <Tooltip>
      <Text>Table</Text>
    </Tooltip>
  </TooltipTrigger>
);
