import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Project } from "@/core/Project";
import { DocClient } from "@/core/sqlite/DocClient";
import { WorkspaceClient, type WorkspaceSearchFtsHit } from "@/core/sqlite/WorkspaceClient";
import { SearchScope } from "@/core/service/dataManageService/contentSearchEngine/contentSearchEngine";
import { jumpToWorkspaceNodeByPath } from "@/core/service/dataManageService/stageTableService/WorkspaceTableSource";
import { WorkspaceManager, WorkspacePaths } from "@/core/service/workspace/WorkspaceManager";
import { RectangleLittleNoteEffect } from "@/core/service/feedbackService/effectEngine/concrete/RectangleLittleNoteEffect";
import { createSubWindow } from "@/core/subWindowOpen";
import { TabWorkspace } from "@/core/TabWorkspace";
import { activeResourceTabAtom } from "@/state";
import { cn } from "@/utils/cn";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { useAtom } from "jotai";
import {
  CaseSensitive,
  FileText,
  Globe,
  MessageCircleQuestionMark,
  Regex,
  Square,
  SquareDashedMousePointer,
  SquareDashedTopSolid,
  Telescope,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

/**
 * 搜索内容的面板
 */
export default function FindWindow({ tabId }: { tabId: string }) {
  const { t } = useTranslation("findWindow");
  const [isCaseSensitive, setIsCaseSensitive] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [searchString, setSearchString] = useState("");
  const [searchError, setSearchError] = useState("");
  const searchErrorId = useId();
  const [searchResults, setSearchResults] = useState<{ title: string; uuid: string }[]>([]);
  const [workspaceHits, setWorkspaceHits] = useState<WorkspaceSearchFtsHit[]>([]);
  const [, setTick] = useState(0);
  // 是否开启快速瞭望模式
  const [isMouseEnterCameraMovable, setIsMouseEnterCameraMovable] = useState(false);
  // 搜索范围
  const [searchScope, setSearchScope] = useState<SearchScope>(SearchScope.ALL);
  const [isWorkspaceScope, setIsWorkspaceScope] = useState(false);
  const [tab] = useAtom(activeResourceTabAtom);
  const project = tab instanceof Project ? tab : undefined;
  const workspaceRoot = WorkspaceManager.root;
  const canSearchWorkspace = Boolean(workspaceRoot && WorkspaceClient.isAvailable());
  const effectiveWorkspaceMode = canSearchWorkspace && (isWorkspaceScope || !project);

  const selectAllResult = () => {
    for (const result of searchResults) {
      const node = project?.stageManager.get(result.uuid);
      if (node) {
        node.isSelected = true;
      }
    }
    toast.success(`${searchResults.length} 个结果已全部选中`);
  };

  useEffect(() => {
    if (effectiveWorkspaceMode) {
      let cancelled = false;
      setSearchError("");
      if (!searchString.trim()) {
        setWorkspaceHits([]);
        return;
      }
      void WorkspaceClient.searchFts({ query: searchString.trim(), limit: 200 })
        .then((hits) => {
          if (!cancelled) setWorkspaceHits(hits);
        })
        .catch(() => {
          if (!cancelled) setWorkspaceHits([]);
        });
      return () => {
        cancelled = true;
      };
    }
    if (!project) return;
    let cancelled = false;
    project.contentSearch.isCaseSensitive = isCaseSensitive;
    project.contentSearch.isRegex = isRegex;
    project.contentSearch.searchScope = searchScope;
    setSearchError("");

    const useAsyncFts =
      searchString !== "" &&
      !isRegex &&
      !isCaseSensitive &&
      searchScope === SearchScope.ALL &&
      project.isSqliteV3 &&
      Boolean(project.v3DocId) &&
      DocClient.isAvailable();

    if (useAsyncFts) {
      void project.contentSearch.startSearchAsync(searchString, false).then(() => {
        if (cancelled) return;
        setSearchResults(
          project.contentSearch.searchResultNodes.map((node) => ({
            title: project.contentSearch.getStageObjectText(node),
            uuid: node.uuid,
          })),
        );
      });
      return () => {
        cancelled = true;
      };
    }

    try {
      project.contentSearch.startSearch(searchString, false);
    } catch (error) {
      if (!isRegex || !(error instanceof SyntaxError)) throw error;
      setSearchError(error.message);
    }
    setSearchResults(
      project.contentSearch.searchResultNodes.map((node) => ({
        title: project.contentSearch.getStageObjectText(node),
        uuid: node.uuid,
      })),
    );
    return () => {
      cancelled = true;
    };
  }, [effectiveWorkspaceMode, project, isCaseSensitive, isRegex, searchScope, searchString]);

  useEffect(() => {
    return () => {
      project?.contentSearch.startSearch("", false);
    };
  }, [project]);

  if (!project && !canSearchWorkspace) return <></>;
  return (
    <div className="flex flex-col gap-2 p-4">
      <Input
        placeholder={effectiveWorkspaceMode ? t("workspacePlaceholder") : "请输入要在舞台上搜索的内容"}
        autoFocus
        type="search"
        aria-invalid={!!searchError}
        aria-describedby={searchError ? searchErrorId : undefined}
        onChange={(e) => {
          setSearchString(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            void TabWorkspace.close(tabId);
          } else if (e.key === "Enter" && !effectiveWorkspaceMode && project) {
            e.preventDefault();
            if (e.shiftKey) {
              project.contentSearch.previousSearchResult();
            } else {
              project.contentSearch.nextSearchResult();
            }
            setTick((t) => t + 1);
          }
        }}
        value={searchString}
      />
      {searchError && (
        <Alert id={searchErrorId} variant="destructive">
          <AlertTitle>{t("invalidRegex")}</AlertTitle>
          <AlertDescription className="break-all">{searchError}</AlertDescription>
        </Alert>
      )}
      <div className="my-1 flex flex-wrap gap-3">
        <Tooltip>
          <TooltipTrigger>
            <Button
              size="icon"
              variant={isCaseSensitive ? "default" : "outline"}
              aria-label="区分大小写"
              aria-pressed={isCaseSensitive}
              onClick={() => {
                const currentResult = !isCaseSensitive;
                setIsCaseSensitive(currentResult);
              }}
            >
              <CaseSensitive />
            </Button>
          </TooltipTrigger>
          <TooltipContent>区分大小写</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger>
            <Button
              size="icon"
              variant={isRegex ? "default" : "outline"}
              aria-label={t("useRegex")}
              aria-pressed={isRegex}
              onClick={() => setIsRegex(!isRegex)}
            >
              <Regex data-icon="inline-start" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("useRegex")}</TooltipContent>
        </Tooltip>

        {/* 搜索范围选择按钮组 */}
        {project && (
          <>
            <Tooltip>
              <TooltipTrigger>
                <Button
                  size="icon"
                  variant={!effectiveWorkspaceMode && searchScope === SearchScope.ALL ? "default" : "outline"}
                  onClick={() => {
                    setIsWorkspaceScope(false);
                    setSearchScope(SearchScope.ALL);
                  }}
                >
                  <Square />
                </Button>
              </TooltipTrigger>
              <TooltipContent>搜索整个舞台</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger>
                <Button
                  size="icon"
                  variant={!effectiveWorkspaceMode && searchScope === SearchScope.SELECTED ? "default" : "outline"}
                  onClick={() => {
                    setIsWorkspaceScope(false);
                    setSearchScope(SearchScope.SELECTED);
                  }}
                >
                  <SquareDashedTopSolid />
                </Button>
              </TooltipTrigger>
              <TooltipContent>只搜索选中的内容</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger>
                <Button
                  size="icon"
                  variant={
                    !effectiveWorkspaceMode && searchScope === SearchScope.SELECTED_BOUNDS ? "default" : "outline"
                  }
                  onClick={() => {
                    setIsWorkspaceScope(false);
                    setSearchScope(SearchScope.SELECTED_BOUNDS);
                  }}
                >
                  <SquareDashedMousePointer />
                </Button>
              </TooltipTrigger>
              <TooltipContent>搜索选中内容的外接矩形范围</TooltipContent>
            </Tooltip>
          </>
        )}

        {canSearchWorkspace && (
          <Tooltip>
            <TooltipTrigger>
              <Button
                size="icon"
                data-find-scope-workspace
                variant={effectiveWorkspaceMode ? "default" : "outline"}
                aria-label={t("scopeWorkspace")}
                onClick={() => setIsWorkspaceScope(true)}
              >
                <Globe />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("scopeWorkspace")}</TooltipContent>
          </Tooltip>
        )}

        {!effectiveWorkspaceMode && searchResults.length > 0 && (
          <Tooltip>
            <TooltipTrigger>
              <Button size="icon" variant="outline" onClick={selectAllResult}>
                <SquareDashedTopSolid strokeWidth={1.5} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>将全部结果选中</TooltipContent>
          </Tooltip>
        )}

        {!effectiveWorkspaceMode && searchResults.length >= 3 && (
          <Tooltip>
            <TooltipTrigger>
              <Button
                size="icon"
                variant={isMouseEnterCameraMovable ? "default" : "outline"}
                onClick={() => {
                  setIsMouseEnterCameraMovable(!isMouseEnterCameraMovable);
                }}
              >
                <Telescope />
              </Button>
            </TooltipTrigger>
            <TooltipContent>快速瞭望模式</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger>
            <Button
              size="icon"
              variant="outline"
              onClick={() => {
                Dialog.confirm(
                  "帮助和提示",
                  "如果关闭窗口后发现红框闪烁残留，可以尝试再打开一次搜索窗口，在搜索框中随便输入点东西然后再删除干净。",
                );
              }}
            >
              <MessageCircleQuestionMark />
            </Button>
          </TooltipTrigger>
          <TooltipContent>使用说明</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex flex-col gap-1 overflow-y-auto">
        {searchString === "" && <div className="text-center">请输入搜索内容</div>}
        {effectiveWorkspaceMode ? (
          <>
            {workspaceHits.length === 0 && searchString.trim() !== "" && (
              <div className="text-center">没有搜索结果:`{searchString}`</div>
            )}
            {workspaceHits.map((hit, index) => (
              <button
                key={`${hit.docId}:${hit.uuid}`}
                type="button"
                data-workspace-search-hit={hit.uuid}
                onClick={() => {
                  if (!workspaceRoot) return;
                  const absPath = WorkspacePaths.join(workspaceRoot, hit.relPath);
                  void jumpToWorkspaceNodeByPath(absPath, hit.uuid);
                }}
                className="hover:bg-accent flex w-full cursor-pointer flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left text-xs transition-colors"
              >
                <div className="flex items-center gap-1.5">
                  <span className="bg-secondary shrink-0 rounded-sm px-1.5 text-[10px] tabular-nums">{index + 1}</span>
                  <span className="bg-muted text-muted-foreground inline-flex max-w-36 shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[10px]">
                    <FileText className="size-2.5 shrink-0" />
                    <span className="truncate">{hit.title}</span>
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{hit.text || hit.uuid}</span>
                </div>
                {hit.detailsPlain && (
                  <div className="text-muted-foreground line-clamp-1 pl-6 text-[11px]">{hit.detailsPlain}</div>
                )}
              </button>
            ))}
          </>
        ) : (
          <>
            {searchResults.length === 0 && searchString !== "" && !searchError && (
              <div className="text-center">没有搜索结果:`{searchString}`</div>
            )}
            {project &&
              searchResults.map((result, index) => (
                <div
                  key={result.uuid}
                  className={cn(
                    "hover:text-panel-success-text flex cursor-pointer truncate text-xs hover:underline",
                    index === project.contentSearch.currentSearchResultIndex &&
                      "bg-accent/60 ring-accent rounded-sm ring-2 ring-inset",
                  )}
                  onMouseEnter={() => {
                    project.controller.resetCountdownTimer();
                    if (isMouseEnterCameraMovable) {
                      const node = project.stageManager.get(result.uuid);
                      if (node) {
                        project.camera.bombMove(node.collisionBox.getRectangle().center);
                        project.effects.addEffect(RectangleLittleNoteEffect.fromSearchNode(node));
                      }
                    }
                  }}
                  onClick={() => {
                    project.controller.resetCountdownTimer();
                    const node = project.stageManager.get(result.uuid);
                    if (node) {
                      project.camera.bombMove(node.collisionBox.getRectangle().center);
                      project.effects.addEffect(RectangleLittleNoteEffect.fromSearchNode(node));
                    }
                  }}
                >
                  <span className="bg-secondary rounded-sm px-2">{index + 1}</span>
                  {result.title}
                </div>
              ))}
          </>
        )}
      </div>
    </div>
  );
}

FindWindow.open = () => {
  createSubWindow("FindWindow", {
    title: "搜索",
    contextTarget: "activeResourceTab",
    children: (tab) => <FindWindow tabId={tab.id} />,
    rect: new Rectangle(new Vector(100, 100), new Vector(300, 600)),
  });
};
