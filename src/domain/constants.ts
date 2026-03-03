import type { HttpMethod, SidebarSection } from "./models";

export const HTTP_METHODS: HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

export const SIDEBAR_SECTIONS: SidebarSection[] = [
  "Collections",
  "History",
  "Environments",
];
