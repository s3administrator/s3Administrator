import Link from "next/link"
import { Button } from "@/components/ui/button"
import {
  Trash2,
  Zap,
  Lock,
  Github,
} from "lucide-react"

export default function LandingPage() {
  return (
    <div className="flex flex-col min-h-screen">
      {/* Hero Section */}
      <section className="flex-1 flex items-center justify-center px-4 py-20 sm:py-32">
        <div className="max-w-3xl w-full text-center space-y-8">
          {/* Tagline */}
          <div className="space-y-4">
            <div className="inline-block px-4 py-2 rounded-full bg-primary/10 text-primary text-sm font-medium">
              ✨ Finally, S3 management that doesn't suck
            </div>

            <h1 className="text-5xl sm:text-6xl font-bold tracking-tight">
              Manage Hetzner S3
              <br />
              <span className="bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">
                like a file manager
              </span>
            </h1>

            <p className="text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              Hetzner's console is missing basic features. Delete folders recursively, bulk operations, search, sort—all the conveniences you expect from a desktop file manager.
            </p>
          </div>

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center pt-4">
            <Button size="lg" asChild className="text-base h-12">
              <Link href="/login">Get Started Free</Link>
            </Button>
            <Button size="lg" variant="outline" asChild className="text-base h-12">
              <a href="https://github.com/yourusername/hetzner-s3-manager" target="_blank" rel="noopener noreferrer">
                <Github className="mr-2 h-5 w-5" />
                View on GitHub
              </a>
            </Button>
          </div>

          {/* Trust Badge */}
          <p className="text-sm text-muted-foreground">
            🔐 Open source • Self-hosted • Credentials encrypted at rest
          </p>
        </div>
      </section>

      {/* Features Section */}
      <section className="bg-muted/40 px-4 py-16">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-12">What you get</h2>

          <div className="grid sm:grid-cols-3 gap-8">
            {/* Feature 1 */}
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex-shrink-0">
                  <Trash2 className="h-6 w-6 text-primary" />
                </div>
                <h3 className="font-semibold text-lg">Recursive Delete</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                Delete entire folders with one click. No more tedious file-by-file removal.
              </p>
            </div>

            {/* Feature 2 */}
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex-shrink-0">
                  <Zap className="h-6 w-6 text-primary" />
                </div>
                <h3 className="font-semibold text-lg">Bulk Operations</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                Select multiple files. Delete, move, or download them all at once.
              </p>
            </div>

            {/* Feature 3 */}
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex-shrink-0">
                  <Lock className="h-6 w-6 text-primary" />
                </div>
                <h3 className="font-semibold text-lg">Fully Encrypted</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                Credentials encrypted with AES-256. Even admins can't see your keys.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="px-4 py-16">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-12">3 minutes to start</h2>

          <div className="grid sm:grid-cols-3 gap-8">
            <div className="text-center space-y-3">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-primary text-primary-foreground font-bold text-lg">
                1
              </div>
              <div>
                <h3 className="font-semibold">Create account</h3>
                <p className="text-sm text-muted-foreground mt-1">Email, GitHub, or Google</p>
              </div>
            </div>

            <div className="text-center space-y-3">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-primary text-primary-foreground font-bold text-lg">
                2
              </div>
              <div>
                <h3 className="font-semibold">Add your credentials</h3>
                <p className="text-sm text-muted-foreground mt-1">Access key & secret</p>
              </div>
            </div>

            <div className="text-center space-y-3">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-primary text-primary-foreground font-bold text-lg">
                3
              </div>
              <div>
                <h3 className="font-semibold">Start managing</h3>
                <p className="text-sm text-muted-foreground mt-1">Browse, upload, delete, move</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer CTA */}
      <section className="border-t px-4 py-12 text-center space-y-4">
        <p className="text-muted-foreground">Ready to stop fighting with Hetzner's console?</p>
        <Button size="lg" asChild>
          <Link href="/login">Get Started Now</Link>
        </Button>
      </section>
    </div>
  )
}
