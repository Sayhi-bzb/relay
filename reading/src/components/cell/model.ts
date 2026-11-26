export type BlogLang = "en" | "zh-CN";
export type ImageDimensions = Readonly<{ width: number; height: number }>;
export type ImageSizes = Readonly<Record<string, ImageDimensions>>;

export type PostCard = Readonly<{
  title: string;
  date: string;
  href: string;
  kind: "article" | "note" | "source";
  category?: string;
}>;

export type CellDocumentNode =
  | Readonly<{ kind: "markdown"; source: string; inlineMath: readonly string[]; wideContent: boolean }>
  | Readonly<{ kind: "heading"; source: string; id: string; level: number; label: string; inlineMath: readonly string[] }>
  | Readonly<{ kind: "ascii"; source: string }>
  | Readonly<{ kind: "animation"; frames: readonly string[]; interval: number; rows: number; width: number }>
  | Readonly<{ kind: "demo"; name: string; source: string; initial: string; interval: number; rows: number; width: number }>
  | Readonly<{ kind: "math"; source: string }>
  | Readonly<{ kind: "image"; src: string; alt: string; caption?: string; size?: ImageDimensions }>
  | Readonly<{ kind: "center"; children: readonly CellDocumentNode[] }>
  | Readonly<{ kind: "list"; ordered: boolean; start: number; items: readonly (readonly CellDocumentNode[])[] }>
  | Readonly<{ kind: "quote"; children: readonly CellDocumentNode[] }>;

export type RelayMode = "brief" | "interpretation" | "original";
export type RelayViews = Readonly<Record<string, { mode: RelayMode; readable: "brief" | "interpretation" }>>;
export type RelayUnit = Readonly<{ id: string; brief: string; interpretation: string; originalText: string; original: readonly CellDocumentNode[]; anchors: readonly string[] }>;
export type RelayDocument = Readonly<{ article: RelayUnit; chunks: readonly RelayUnit[] }>;

type PageBase = Readonly<{
  lang: BlogLang;
  title: string;
  description: string;
  translationUrl?: string;
  appearance?: "auto" | "light" | "dark";
}>;

export type BlogPageModel = PageBase & (
  | Readonly<{ kind: "home"; posts: readonly PostCard[]; products?: readonly { name: string; href: string }[] }>
  | Readonly<{ kind: "listing"; posts: readonly PostCard[]; emptyText: string; showType?: boolean; grouped?: boolean }>
  | Readonly<{ kind: "post"; date: string; postKind: PostCard["kind"]; sourceUrl: string; publisher?: string; author?: string; document: readonly CellDocumentNode[]; relay?: RelayDocument }>
  | Readonly<{ kind: "about" }>
  | Readonly<{ kind: "not-found" }>
);
