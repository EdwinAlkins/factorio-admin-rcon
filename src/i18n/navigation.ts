import { createNavigation } from "next-intl/navigation";
import { routing } from "@/i18n/routing";

/**
 * Remplaçants locale-aware de `next/link` et `next/navigation` : ils préservent
 * le préfixe de langue, que les helpers de Next ignorent.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
