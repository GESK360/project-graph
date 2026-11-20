import { BasicBlocksKit } from "@/components/editor/plugins/basic-blocks-kit";
import { BasicMarksKit } from "@/components/editor/plugins/basic-marks-kit";
import { CodeBlockKit } from "@/components/editor/plugins/code-block-kit";
import { FixedToolbarKit } from "@/components/editor/plugins/fixed-toolbar-kit";
import { FloatingToolbarKit } from "@/components/editor/plugins/floating-toolbar-kit";
import { FontKit } from "@/components/editor/plugins/font-kit";
import { LinkKit } from "@/components/editor/plugins/link-kit";
import { ListKit } from "@/components/editor/plugins/list-kit";
import { MathKit } from "@/components/editor/plugins/math-kit";
import { TableKit } from "@/components/editor/plugins/table-kit";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog } from "@/components/ui/dialog";
import { Settings } from "@/core/service/Settings";
import { createSubWindow } from "@/core/subWindowOpen";
import { TabWorkspace } from "@/core/TabWorkspace";
import { store, tabsAtom } from "@/state";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import i18next from "i18next";
import { upsertLink } from "@platejs/link";
import { Value } from "platejs";
import { Plate, useEditorRef, usePlateEditor } from "platejs/react";
import { Link2 } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

const detailTabIds = new Set<string>();

export default function NodeDetailsWindow({
  tabId,
  value = [],
  onChange = () => {},
}: {
  tabId: string;
  value?: Value;
  onChange?: (value: Value) => void;
}) {
  useEffect(() => {
    return () => {
      detailTabIds.delete(tabId);
    };
  }, [tabId]);

  const editor = usePlateEditor({
    plugins: [
      ...FloatingToolbarKit,
      ...FixedToolbarKit,
      ...BasicMarksKit,
      ...BasicBlocksKit,
      ...FontKit,
      ...TableKit,
      ...MathKit,
      ...CodeBlockKit,
      ...ListKit,
      ...LinkKit,
    ],
    value,
  });

  return (
    <Plate editor={editor} onChange={({ value }) => onChange(value)}>
      <SelectedTextContextMenu>
        <EditorContainer>
          <Editor variant="nodeDetails" />
        </EditorContainer>
      </SelectedTextContextMenu>
    </Plate>
  );
}

function SelectedTextContextMenu({ children }: { children: ReactNode }) {
  const editor = useEditorRef();
  const { t } = useTranslation("nodeDetailsWindow");
  const [contextMenuEnabled] = Settings.use("enableTextSelectionContextMenu");
  const selectionRef = useRef(editor.selection);
  const [hasSelection, setHasSelection] = useState(false);

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!contextMenuEnabled || !editor.selection || editor.api.isCollapsed()) {
      selectionRef.current = null;
      setHasSelection(false);
      event.preventDefault();
      return;
    }

    const { anchor, focus } = editor.selection;
    selectionRef.current = {
      anchor: { ...anchor, path: [...anchor.path] },
      focus: { ...focus, path: [...focus.path] },
    };
    setHasSelection(true);
  };

  const makeSelectedTextLink = async () => {
    const selection = selectionRef.current;
    if (!selection) return;

    const value = await Dialog.input(t("createLinkTitle"), t("createLinkPrompt"), {
      placeholder: t("createLinkPlaceholder"),
    });
    if (!value?.trim()) return;

    const trimmed = value.trim();
    if (/^(javascript|data|vbscript):/i.test(trimmed)) return;
    const url = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;

    editor.tf.select(selection);
    upsertLink(editor, { url });
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="h-full min-h-0" onContextMenu={handleContextMenu}>
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {hasSelection && contextMenuEnabled && (
          <ContextMenuItem
            aria-label={t("createLink")}
            className="size-8 justify-center p-0"
            title={t("createLinkDescription")}
            onSelect={() => void makeSelectedTextLink()}
          >
            <Link2 />
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

NodeDetailsWindow.open = (value?: Value, onChange?: (value: Value) => void) => {
  const existing = store.get(tabsAtom).find((tab) => !tab.closing && detailTabIds.has(tab.id));
  if (existing) {
    void TabWorkspace.close(existing.id);
    return;
  }

  const tab = createSubWindow("NodeDetailsWindow", {
    title: i18next.t("title", { ns: "nodeDetailsWindow", defaultValue: "详细信息" }),
    children: (componentTab) => <NodeDetailsWindow tabId={componentTab.id} value={value} onChange={onChange} />,
    rect: new Rectangle(
      new Vector(innerWidth * 0.75, innerHeight * 0.1),
      new Vector(innerWidth * 0.25, innerHeight * 0.9),
    ),
    titleBarOverlay: true,
  });
  detailTabIds.add(tab.id);
};
