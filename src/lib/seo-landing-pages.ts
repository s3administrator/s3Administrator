export type SeoLandingCategory = "features" | "providers" | "compare"

type SeoFaqItem = {
  question: string
  answer: string
}

type SeoRelatedLink = {
  href: string
  label: string
}

export type SeoLandingPageConfig = {
  category: SeoLandingCategory
  slug: string
  title: string
  description: string
  h1: string
  intro: string
  problemPoints: string[]
  solutionPoints: string[]
  proofPoints: string[]
  keywords: string[]
  faq: SeoFaqItem[]
  relatedLinks: SeoRelatedLink[]
}

export const seoLandingPages: SeoLandingPageConfig[] = [
  {
    category: "features",
    slug: "s3-file-manager",
    title: "S3 File Manager with Bulk Operations",
    description:
      "Manage S3 buckets like a desktop file manager with search, batch actions, recursive delete, and multi-provider support.",
    h1: "S3 File Manager Built for Real Operations",
    intro:
      "S3 Admin gives ops and platform teams a fast way to browse, search, move, and clean object storage across AWS, Hetzner, and Cloudflare R2.",
    problemPoints: [
      "Native S3 consoles are slow for high-volume folders.",
      "Common tasks like moving or deleting many objects take too many steps.",
      "Teams lose time switching between provider-specific UIs.",
    ],
    solutionPoints: [
      "Browse buckets and prefixes with file-manager style navigation.",
      "Run bulk actions for delete, move, and download from a single interface.",
      "Use one workflow for AWS S3 and S3-compatible providers.",
    ],
    proofPoints: [
      "Recursive folder delete for deep prefixes.",
      "Server-side search and task processing for long-running operations.",
      "Role-based auth, audit logs, and encrypted credentials.",
    ],
    keywords: [
      "s3 file manager",
      "s3 browser",
      "s3 admin tool",
      "s3 bulk operations",
    ],
    faq: [
      {
        question: "Does this work only with AWS?",
        answer:
          "No. It works with AWS and S3-compatible providers like Hetzner Object Storage and Cloudflare R2.",
      },
      {
        question: "Can I self-host S3 Admin?",
        answer:
          "Yes. S3 Admin is open source and designed for self-hosted deployment.",
      },
      {
        question: "Can it handle large object lists?",
        answer:
          "Yes. It includes pagination, search, and background task handling for large datasets.",
      },
    ],
    relatedLinks: [
      { href: "/pricing", label: "See pricing" },
      { href: "/features/s3-bulk-delete-tool", label: "S3 bulk delete tool" },
      { href: "/providers/hetzner-s3-browser", label: "Hetzner S3 browser" },
      { href: "/compare/s3-console-alternative", label: "S3 console alternative" },
    ],
  },
  {
    category: "features",
    slug: "s3-bulk-delete-tool",
    title: "S3 Bulk Delete Tool for Large Prefixes",
    description:
      "Delete thousands of S3 objects safely with bulk actions, task progress visibility, and recursive prefix cleanup.",
    h1: "Bulk Delete S3 Objects Without CLI Scripts",
    intro:
      "S3 Admin turns repetitive delete workflows into guided bulk actions with clear progress and fewer operational mistakes.",
    problemPoints: [
      "Deleting many objects manually is slow and error-prone.",
      "CLI scripts are powerful but hard to share with non-engineers.",
      "Native UIs often fail to give clear feedback for large deletes.",
    ],
    solutionPoints: [
      "Select many objects and delete them in one action.",
      "Run recursive cleanup for nested prefixes.",
      "Track long-running operations with background tasks.",
    ],
    proofPoints: [
      "Task queue endpoints for transfer and deletion jobs.",
      "Audit logging for operational actions.",
      "Search and filtering before destructive actions.",
    ],
    keywords: [
      "s3 bulk delete tool",
      "delete s3 folder recursively",
      "s3 delete multiple files",
      "s3 object cleanup",
    ],
    faq: [
      {
        question: "Can I bulk delete a folder and subfolders?",
        answer:
          "Yes. Recursive prefix deletion removes nested objects under the selected path.",
      },
      {
        question: "Is there task tracking for large deletions?",
        answer:
          "Yes. Background tasks expose status so teams can monitor and verify completion.",
      },
      {
        question: "Can I review items before deleting?",
        answer:
          "Yes. You can search, sort, and select explicit objects before confirming deletion.",
      },
    ],
    relatedLinks: [
      { href: "/pricing", label: "Start free" },
      { href: "/features/s3-recursive-folder-delete", label: "Recursive folder delete" },
      { href: "/providers/aws-s3-file-manager", label: "AWS S3 file manager" },
      { href: "/compare/aws-console-vs-s3-admin", label: "AWS console comparison" },
    ],
  },
  {
    category: "features",
    slug: "s3-recursive-folder-delete",
    title: "S3 Recursive Folder Delete",
    description:
      "Clean nested S3 prefixes quickly with recursive folder delete, safer review workflows, and audit-ready operations.",
    h1: "Recursive S3 Folder Delete Without Friction",
    intro:
      "Remove deep folder trees from object storage with fewer clicks and better visibility than default S3 consoles.",
    problemPoints: [
      "Object storage does not have real folders, which makes cleanup confusing.",
      "Manual deletes across nested prefixes are tedious and risky.",
      "Teams need an auditable process for destructive actions.",
    ],
    solutionPoints: [
      "Treat prefixes like folders in a familiar file-manager UI.",
      "Run recursive deletion from a single action.",
      "Capture deletion activity through audit logs and task history.",
    ],
    proofPoints: [
      "Prefix-aware navigation in dashboard flows.",
      "Bulk action APIs for delete and move operations.",
      "Admin and audit interfaces for traceability.",
    ],
    keywords: [
      "s3 recursive folder delete",
      "delete s3 prefix",
      "s3 folder cleanup",
      "s3 delete nested files",
    ],
    faq: [
      {
        question: "Does recursive delete remove all files under a prefix?",
        answer:
          "Yes. It targets all objects under the selected prefix to fully clear nested content.",
      },
      {
        question: "Can I run this on S3-compatible storage?",
        answer:
          "Yes. Recursive delete works for S3-compatible providers supported by your credentials.",
      },
      {
        question: "Is this suitable for operational teams?",
        answer:
          "Yes. Teams use it to speed up storage hygiene and reduce manual cleanup effort.",
      },
    ],
    relatedLinks: [
      { href: "/pricing", label: "Pricing" },
      { href: "/features/s3-bulk-delete-tool", label: "Bulk delete workflows" },
      { href: "/providers/cloudflare-r2-file-manager", label: "Cloudflare R2 manager" },
      { href: "/compare/s3-console-alternative", label: "Alternatives to default consoles" },
    ],
  },
  {
    category: "providers",
    slug: "hetzner-s3-browser",
    title: "Hetzner S3 Browser and File Manager",
    description:
      "Use a faster Hetzner Object Storage browser with bulk actions, recursive delete, and cross-provider S3 workflows.",
    h1: "Hetzner S3 Browser for Daily Storage Operations",
    intro:
      "S3 Admin makes Hetzner Object Storage easier to manage with a clean UI for large bucket operations and ongoing cleanup tasks.",
    problemPoints: [
      "Teams need a practical browser for Hetzner S3 buckets.",
      "Bulk actions and recursive cleanup are cumbersome in default tooling.",
      "Cross-provider teams want one interface across environments.",
    ],
    solutionPoints: [
      "Connect Hetzner credentials and manage objects immediately.",
      "Use bulk delete, move, and search for faster daily operations.",
      "Standardize workflows across Hetzner, AWS, and R2.",
    ],
    proofPoints: [
      "S3-compatible credential testing endpoints.",
      "Upload, preview, and object usage APIs.",
      "Operational audit trail and task history.",
    ],
    keywords: [
      "hetzner s3 browser",
      "hetzner object storage manager",
      "hetzner s3 file manager",
      "s3 compatible browser",
    ],
    faq: [
      {
        question: "Is Hetzner Object Storage fully compatible?",
        answer:
          "Yes. Hetzner is S3-compatible and can be used with the same workflow as other providers.",
      },
      {
        question: "Can I switch between Hetzner and AWS buckets?",
        answer:
          "Yes. S3 Admin is designed for multi-provider storage management.",
      },
      {
        question: "Can I search objects in Hetzner buckets?",
        answer:
          "Yes. Search and sort are available to help locate objects quickly.",
      },
    ],
    relatedLinks: [
      { href: "/pricing", label: "Get started" },
      { href: "/providers/aws-s3-file-manager", label: "AWS S3 manager" },
      {
        href: "/providers/cloudflare-r2-file-manager",
        label: "Cloudflare R2 manager",
      },
      { href: "/features/s3-file-manager", label: "Core S3 file manager" },
    ],
  },
  {
    category: "providers",
    slug: "cloudflare-r2-file-manager",
    title: "Cloudflare R2 File Manager",
    description:
      "Manage Cloudflare R2 buckets with a practical file manager UI, bulk operations, and recursive cleanup.",
    h1: "Cloudflare R2 File Manager for Faster Workflows",
    intro:
      "S3 Admin helps teams manage R2 objects with the same efficient workflow used for AWS S3 and other S3-compatible providers.",
    problemPoints: [
      "R2-heavy teams need better day-to-day object workflows.",
      "Moving and deleting large sets of files takes too many steps.",
      "Mixed cloud teams need a shared interface.",
    ],
    solutionPoints: [
      "Use one dashboard for browsing, searching, and bulk actions.",
      "Run recursive delete and move jobs across large prefixes.",
      "Keep operations consistent across R2, AWS, and Hetzner.",
    ],
    proofPoints: [
      "Bulk APIs for delete and transfer tasks.",
      "Search endpoint for object discovery.",
      "Pricing and plan system for team-scale usage.",
    ],
    keywords: [
      "cloudflare r2 file manager",
      "r2 bucket browser",
      "r2 object manager",
      "s3 compatible r2 tool",
    ],
    faq: [
      {
        question: "Can I use this as a Cloudflare R2 browser?",
        answer:
          "Yes. It provides a file-manager style interface for R2 buckets.",
      },
      {
        question: "Does it support batch operations in R2?",
        answer:
          "Yes. You can run bulk delete and related operations on selected objects.",
      },
      {
        question: "Can I manage R2 and AWS in the same app?",
        answer:
          "Yes. S3 Admin is built for multi-provider object storage workflows.",
      },
    ],
    relatedLinks: [
      { href: "/pricing", label: "View plans" },
      { href: "/providers/hetzner-s3-browser", label: "Hetzner browser" },
      { href: "/providers/aws-s3-file-manager", label: "AWS manager" },
      { href: "/compare/r2-dashboard-alternative", label: "R2 dashboard alternative" },
    ],
  },
  {
    category: "providers",
    slug: "aws-s3-file-manager",
    title: "AWS S3 File Manager",
    description:
      "A faster AWS S3 file manager with bulk actions, recursive prefix cleanup, and workflow-focused navigation.",
    h1: "AWS S3 File Manager for Ops and Platform Teams",
    intro:
      "S3 Admin is a practical alternative for teams that need faster AWS S3 workflows than the default console experience.",
    problemPoints: [
      "AWS console flows can be slow for repetitive object management.",
      "Large prefix cleanup often requires CLI scripts.",
      "Non-engineers need a safer UI for day-to-day tasks.",
    ],
    solutionPoints: [
      "Handle bulk object actions directly from the UI.",
      "Use recursive delete for deep cleanup tasks.",
      "Provide a shared operational interface across teams.",
    ],
    proofPoints: [
      "Task processing endpoints for asynchronous operations.",
      "Admin/audit views for accountability.",
      "Credential encryption and access controls.",
    ],
    keywords: [
      "aws s3 file manager",
      "s3 manager alternative",
      "aws s3 bulk delete",
      "s3 console replacement",
    ],
    faq: [
      {
        question: "Does this replace the AWS S3 console?",
        answer:
          "It complements or replaces console workflows for teams that need faster bulk operations and simpler navigation.",
      },
      {
        question: "Can I keep using IAM credentials?",
        answer:
          "Yes. You can connect standard S3-compatible credentials for bucket access.",
      },
      {
        question: "Is it suitable for support or operations teams?",
        answer:
          "Yes. The UI is designed for repeatable day-to-day operational tasks.",
      },
    ],
    relatedLinks: [
      { href: "/pricing", label: "Start free" },
      { href: "/features/s3-bulk-delete-tool", label: "Bulk delete feature" },
      { href: "/compare/aws-console-vs-s3-admin", label: "AWS console comparison" },
      { href: "/compare/s3-console-alternative", label: "S3 console alternatives" },
    ],
  },
  {
    category: "compare",
    slug: "s3-console-alternative",
    title: "S3 Console Alternative",
    description:
      "Looking for an S3 console alternative? Compare a workflow-first file manager with better bulk operations and cleanup tools.",
    h1: "A Practical Alternative to Default S3 Consoles",
    intro:
      "If your team spends too much time in provider consoles for repetitive tasks, S3 Admin offers a faster and more consistent workflow.",
    problemPoints: [
      "Provider consoles optimize for breadth, not repetitive operations.",
      "Bulk actions and cleanup workflows take too many clicks.",
      "Cross-provider teams must relearn each interface.",
    ],
    solutionPoints: [
      "Use a consistent file-manager UI across providers.",
      "Perform high-frequency actions with fewer steps.",
      "Support engineering and support teams with the same interface.",
    ],
    proofPoints: [
      "Recursive delete and bulk task APIs.",
      "Provider-agnostic S3 credential handling.",
      "Pricing tiers for growing operational needs.",
    ],
    keywords: [
      "s3 console alternative",
      "s3 admin panel",
      "s3 dashboard alternative",
      "self-hosted s3 manager",
    ],
    faq: [
      {
        question: "When should I use an S3 console alternative?",
        answer:
          "When your daily object operations rely on bulk tasks, repetitive cleanup, or multi-provider workflows.",
      },
      {
        question: "Is S3 Admin open source?",
        answer:
          "Yes. It is open source and can be self-hosted.",
      },
      {
        question: "Can I still use provider-native tools?",
        answer:
          "Yes. Many teams use S3 Admin for daily operations and native consoles for occasional provider-specific settings.",
      },
    ],
    relatedLinks: [
      { href: "/pricing", label: "See pricing" },
      { href: "/compare/aws-console-vs-s3-admin", label: "AWS comparison" },
      { href: "/compare/r2-dashboard-alternative", label: "R2 comparison" },
      { href: "/features/s3-file-manager", label: "S3 file manager" },
    ],
  },
  {
    category: "compare",
    slug: "aws-console-vs-s3-admin",
    title: "AWS S3 Console vs S3 Admin",
    description:
      "Compare AWS S3 Console and S3 Admin for bulk actions, recursive cleanup, and daily object management workflows.",
    h1: "AWS S3 Console vs S3 Admin: Workflow Comparison",
    intro:
      "AWS console is excellent for broad AWS control. S3 Admin focuses on faster, repeatable object storage operations.",
    problemPoints: [
      "Console workflows can feel slow for high-frequency tasks.",
      "Teams need simpler bulk operations and cleanup controls.",
      "Operational users often need clearer task tracking.",
    ],
    solutionPoints: [
      "Use S3 Admin for day-to-day object operations.",
      "Keep AWS console for broader cloud administration.",
      "Reduce operational friction with purpose-built actions.",
    ],
    proofPoints: [
      "Bulk delete, move, and task processing endpoints.",
      "Search and list APIs tuned for object workflows.",
      "Auth, billing, and admin controls for team usage.",
    ],
    keywords: [
      "aws s3 console vs",
      "aws s3 console alternative",
      "s3 admin comparison",
      "s3 bulk operations ui",
    ],
    faq: [
      {
        question: "Should I replace the AWS console entirely?",
        answer:
          "Most teams use both: S3 Admin for operational speed and AWS console for broader AWS configuration.",
      },
      {
        question: "Which is better for bulk object cleanup?",
        answer:
          "S3 Admin is optimized for bulk workflows and recursive cleanup.",
      },
      {
        question: "Is migration difficult?",
        answer:
          "No. You can start by connecting existing S3 credentials and using S3 Admin for selected workflows.",
      },
    ],
    relatedLinks: [
      { href: "/pricing", label: "Try S3 Admin" },
      { href: "/providers/aws-s3-file-manager", label: "AWS S3 manager" },
      { href: "/features/s3-bulk-delete-tool", label: "Bulk delete" },
      { href: "/compare/s3-console-alternative", label: "More alternatives" },
    ],
  },
  {
    category: "compare",
    slug: "r2-dashboard-alternative",
    title: "Cloudflare R2 Dashboard Alternative",
    description:
      "Compare Cloudflare R2 Dashboard with S3 Admin for faster object operations, bulk actions, and multi-provider workflows.",
    h1: "Alternative to the Cloudflare R2 Dashboard",
    intro:
      "S3 Admin helps teams that need faster object workflows and a shared interface across R2 and other S3-compatible providers.",
    problemPoints: [
      "R2 teams often need deeper bulk workflows than default dashboards.",
      "Cross-provider operations increase context switching.",
      "Support teams need a repeatable file-manager style interface.",
    ],
    solutionPoints: [
      "Use S3 Admin for operational object management and cleanup.",
      "Run the same workflows across R2, AWS, and Hetzner.",
      "Expose clear actions for non-engineering users.",
    ],
    proofPoints: [
      "S3-compatible provider architecture.",
      "Search, preview, and task operations for storage workflows.",
      "Self-hosted deployment with auth and role controls.",
    ],
    keywords: [
      "r2 dashboard alternative",
      "cloudflare r2 alternative",
      "r2 file manager",
      "r2 object browser",
    ],
    faq: [
      {
        question: "Can S3 Admin manage only R2?",
        answer:
          "Yes. You can use it solely for R2 or across multiple S3-compatible providers.",
      },
      {
        question: "Does it help with batch tasks?",
        answer:
          "Yes. It is built for frequent bulk operations and recursive cleanup.",
      },
      {
        question: "Is it suitable for teams?",
        answer:
          "Yes. It includes authentication, role-based access, and operational auditing features.",
      },
    ],
    relatedLinks: [
      { href: "/pricing", label: "View pricing" },
      { href: "/providers/cloudflare-r2-file-manager", label: "R2 file manager" },
      { href: "/compare/s3-console-alternative", label: "S3 console alternatives" },
      { href: "/features/s3-file-manager", label: "Core features" },
    ],
  },
]

export function getSeoLandingPagesByCategory(
  category: SeoLandingCategory,
): SeoLandingPageConfig[] {
  return seoLandingPages.filter((page) => page.category === category)
}

export function getSeoLandingPage(
  category: SeoLandingCategory,
  slug: string,
): SeoLandingPageConfig | undefined {
  return seoLandingPages.find(
    (page) => page.category === category && page.slug === slug,
  )
}
