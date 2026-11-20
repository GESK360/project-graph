// @ts-nocheck
"use client";

import * as React from "react";

import type { TLinkElement } from "platejs";
import type { PlateElementProps } from "platejs/react";

import { getLinkAttributes } from "@platejs/link";
import { PlateElement } from "platejs/react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { isWeb } from "@/utils/platform";
import { toast } from "sonner";

export function LinkElement(props: PlateElementProps<TLinkElement>) {
  const linkAttributes = getLinkAttributes(props.editor, props.element);

  return (
    <PlateElement
      {...props}
      as="a"
      className="text-primary decoration-primary font-medium underline underline-offset-4"
      attributes={{
        ...props.attributes,
        ...linkAttributes,
        onClick: (event) => {
          const href = linkAttributes.href;
          if (!href) return;
          event.preventDefault();
          event.stopPropagation();
          if (isWeb) {
            window.open(href, "_blank", "noopener,noreferrer");
          } else {
            void openExternal(href).catch((error) => toast.error(String(error)));
          }
        },
        onMouseOver: (e) => {
          e.stopPropagation();
        },
      }}
    >
      {props.children}
    </PlateElement>
  );
}
