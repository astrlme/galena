"use client";

import { createContext, useContext } from "react";

/**
 * Where menus and select popups render. Inside a sheet or dialog that traps focus and blocks the
 * page behind it, a popup on `document.body` could be neither focused nor clicked, so the modal
 * offers its own panel; elsewhere this is null and popups go to the body.
 */
export const PortalContainer = createContext<HTMLElement | null>(null);

export const usePortalContainer = () => useContext(PortalContainer);
