"use client"

import { useTheme } from "next-themes"
import { Sun, Moon, Eclipse, SunDim, Circle } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function ThemeSwitcher() {
  const { setTheme, resolvedTheme } = useTheme()
  const activeTheme = resolvedTheme ?? "light"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 w-8 px-0">
          {activeTheme === "midnight" ? (
            <Eclipse className="h-4 w-4" />
          ) : activeTheme === "dark" ? (
            <Moon className="h-4 w-4" />
          ) : activeTheme === "matte" ? (
            <Circle className="h-4 w-4" />
          ) : activeTheme === "soft" ? (
            <SunDim className="h-4 w-4" />
          ) : (
            <Sun className="h-4 w-4" />
          )}
          <span className="sr-only">Toggle theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme("light")}>
          <Sun className="mr-2 h-4 w-4" />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("matte")}>
          <Circle className="mr-2 h-4 w-4" />
          Matte Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("soft")}>
          <SunDim className="mr-2 h-4 w-4" />
          Soft Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("midnight")}>
          <Eclipse className="mr-2 h-4 w-4" />
          Midnight
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          <Moon className="mr-2 h-4 w-4" />
          Dark
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
