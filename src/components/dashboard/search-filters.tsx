"use client"

import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { LayoutGrid, List, Search } from "lucide-react"

interface Credential {
  id: string
  label: string
}

interface Bucket {
  name: string
  credentialId: string
}

const FILE_TYPES = ["all", "image", "video", "audio", "document", "archive", "code", "other"]

interface SearchFiltersProps {
  query: string
  onQueryChange: (value: string) => void
  credentials: Credential[]
  selectedCredentialIds: string[]
  onToggleCredential: (credentialId: string) => void
  onClearCredentials: () => void
  filteredBucketScopes: Bucket[]
  credentialsById: Map<string, string>
  selectedBucketScopes: string[]
  onToggleBucketScope: (scope: string) => void
  onClearBucketScopes: () => void
  selectedType: string
  onTypeChange: (type: string) => void
  viewMode?: "list" | "gallery"
  onViewModeChange?: (mode: "list" | "gallery") => void
}

export function SearchFilters({
  query,
  onQueryChange,
  credentials,
  selectedCredentialIds,
  onToggleCredential,
  onClearCredentials,
  filteredBucketScopes,
  credentialsById,
  selectedBucketScopes,
  onToggleBucketScope,
  onClearBucketScopes,
  selectedType,
  onTypeChange,
  viewMode = "list",
  onViewModeChange,
}: SearchFiltersProps) {
  return (
    <div className="space-y-3 border-b px-4 py-3">
      <div>
        <h1 className="text-xl font-semibold">Global Search</h1>
        <p className="text-sm text-muted-foreground">
          Search across all credentials and buckets
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[280px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by file name..."
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            className="h-9 pl-9"
            autoFocus
          />
        </div>

        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              Accounts {selectedCredentialIds.length > 0 && `(${selectedCredentialIds.length})`}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-56"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <DropdownMenuLabel>Filter by account</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={selectedCredentialIds.length === 0}
              onCheckedChange={onClearCredentials}
              onSelect={(event) => event.preventDefault()}
            >
              All Accounts
            </DropdownMenuCheckboxItem>
            {credentials.length > 0 && <DropdownMenuSeparator />}
            {credentials.map((credential) => (
              <DropdownMenuCheckboxItem
                key={credential.id}
                checked={selectedCredentialIds.includes(credential.id)}
                onCheckedChange={() => onToggleCredential(credential.id)}
                onSelect={(event) => event.preventDefault()}
              >
                {credential.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              Buckets {selectedBucketScopes.length > 0 && `(${selectedBucketScopes.length})`}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-72"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <DropdownMenuLabel>Filter by bucket</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={selectedBucketScopes.length === 0}
              onCheckedChange={onClearBucketScopes}
              onSelect={(event) => event.preventDefault()}
            >
              All Buckets
            </DropdownMenuCheckboxItem>
            {filteredBucketScopes.length > 0 && <DropdownMenuSeparator />}
            {filteredBucketScopes.map((bucket) => {
              const scope = `${bucket.credentialId}::${bucket.name}`
              const label = credentialsById.get(bucket.credentialId) ?? "Unknown"
              return (
                <DropdownMenuCheckboxItem
                  key={scope}
                  checked={selectedBucketScopes.includes(scope)}
                  onCheckedChange={() => onToggleBucketScope(scope)}
                  onSelect={(event) => event.preventDefault()}
                >
                  {bucket.name} · {label}
                </DropdownMenuCheckboxItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              Type: {selectedType === "all" ? "All" : selectedType}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            {FILE_TYPES.map((type) => (
              <DropdownMenuItem
                key={type}
                onClick={() => onTypeChange(type)}
              >
                {type === "all" ? "All Types" : `${type[0].toUpperCase()}${type.slice(1)}`}
                {selectedType === type && " ✓"}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {onViewModeChange && (
          <div className="ml-auto flex items-center overflow-hidden rounded-md border">
            <Button
              type="button"
              variant={viewMode === "list" ? "secondary" : "ghost"}
              size="sm"
              className="h-9 rounded-none border-0"
              onClick={() => onViewModeChange("list")}
            >
              <List className="mr-1.5 h-4 w-4" />
              List
            </Button>
            <Button
              type="button"
              variant={viewMode === "gallery" ? "secondary" : "ghost"}
              size="sm"
              className="h-9 rounded-none border-0"
              onClick={() => onViewModeChange("gallery")}
            >
              <LayoutGrid className="mr-1.5 h-4 w-4" />
              Gallery
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
