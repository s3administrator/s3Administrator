"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import {
  Search,
  Upload,
  FolderPlus,
  RefreshCw,
  Home,
  ArrowUpDown,
  LayoutGrid,
  List,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

interface TopbarProps {
  bucket: string
  prefix: string
  credentialId?: string
  onSearch: (query: string) => void
  onUpload: () => void
  onSync: () => void
  onCreateFolder: () => void
  onSort?: (column: "name" | "size" | "lastModified") => void
  sortBy?: string
  sortDir?: string
  viewMode?: "list" | "gallery"
  onViewModeChange?: (mode: "list" | "gallery") => void
}

function buildBreadcrumbSegments(bucket: string, prefix: string, credentialId?: string) {
  const credentialQuery = credentialId
    ? `&credentialId=${encodeURIComponent(credentialId)}`
    : ""
  const segments: { label: string; href: string }[] = []

  if (bucket) {
    segments.push({
      label: bucket,
      href: `/dashboard?bucket=${encodeURIComponent(bucket)}${credentialQuery}`,
    })

    if (prefix) {
      const parts = prefix.replace(/\/$/, "").split("/")
      let accumulated = ""
      for (const part of parts) {
        accumulated += part + "/"
        segments.push({
          label: part,
          href: `/dashboard?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(accumulated)}${credentialQuery}`,
        })
      }
    }
  }

  return segments
}

export function Topbar({
  bucket,
  prefix,
  credentialId,
  onSearch,
  onUpload,
  onSync,
  onCreateFolder,
  onSort,
  sortBy,
  sortDir,
  viewMode = "list",
  onViewModeChange,
}: TopbarProps) {
  const [searchValue, setSearchValue] = useState("")
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchValue(value)
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
      debounceRef.current = setTimeout(() => {
        onSearch(value)
      }, 300)
    },
    [onSearch]
  )

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [])

  const segments = buildBreadcrumbSegments(bucket, prefix, credentialId)
  const lastSegment = segments[segments.length - 1]
  const parentSegments = segments.slice(0, -1)

  return (
    <div className="flex flex-col gap-3 border-b px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href="/dashboard">
                  <Home className="h-4 w-4" />
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>

            {parentSegments.map((segment) => (
              <React.Fragment key={segment.href}>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link href={segment.href}>{segment.label}</Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
              </React.Fragment>
            ))}

            {lastSegment && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{lastSegment.label}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </BreadcrumbList>
        </Breadcrumb>

        <div className="flex items-center gap-2">
          {onViewModeChange && (
            <div className="flex items-center overflow-hidden rounded-md border">
              <Button
                type="button"
                variant={viewMode === "list" ? "secondary" : "ghost"}
                size="sm"
                className="h-8 rounded-none border-0"
                onClick={() => onViewModeChange("list")}
              >
                <List className="mr-1.5 h-4 w-4" />
                List
              </Button>
              <Button
                type="button"
                variant={viewMode === "gallery" ? "secondary" : "ghost"}
                size="sm"
                className="h-8 rounded-none border-0"
                onClick={() => onViewModeChange("gallery")}
              >
                <LayoutGrid className="mr-1.5 h-4 w-4" />
                Gallery
              </Button>
            </div>
          )}
          <Button variant="outline" size="sm" onClick={onUpload}>
            <Upload className="mr-1.5 h-4 w-4" />
            Upload
          </Button>
          <Button variant="outline" size="sm" onClick={onCreateFolder}>
            <FolderPlus className="mr-1.5 h-4 w-4" />
            New Folder
          </Button>
          {onSort && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <ArrowUpDown className="mr-1.5 h-4 w-4" />
                  Sort
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onSort("name")}>
                  Name {sortBy === "name" && (sortDir === "asc" ? "↑" : "↓")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSort("size")}>
                  Size {sortBy === "size" && (sortDir === "asc" ? "↑" : "↓")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSort("lastModified")}>
                  Date{" "}
                  {sortBy === "lastModified" &&
                    (sortDir === "asc" ? "↑" : "↓")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button variant="outline" size="sm" onClick={onSync}>
            <RefreshCw className="mr-1.5 h-4 w-4" />
            Sync
          </Button>
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search files and folders..."
          value={searchValue}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>
    </div>
  )
}
