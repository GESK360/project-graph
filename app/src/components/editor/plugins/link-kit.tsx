"use client";

import { LinkPlugin } from "@platejs/link/react";

import { LinkElement } from "@/components/ui/link-node";
import { LinkFloatingToolbar } from "@/components/ui/link-toolbar";

export const LinkKit = [
  LinkPlugin.configure({
    options: {
      allowedSchemes: [
        "http",
        "https",
        "mailto",
        "tel",
        "file",
        "ftp",
        "ftps",
        "vscode",
        "obsidian",
        "notion",
        "slack",
        "discord",
        "steam",
        "tg",
        "zoommtg",
        "msteams",
      ],
    },
    render: {
      node: LinkElement,
      afterEditable: () => <LinkFloatingToolbar />,
    },
  }),
];
