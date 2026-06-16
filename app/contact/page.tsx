"use client";

import Link from "next/link";
import { Mail, ArrowLeft } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim() || "";

export default function ContactPage() {
  return (
    <DashboardLayout>
      <div className="max-w-lg mx-auto py-8">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-accent transition-colors mb-8"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to dashboard
        </Link>
        <div className="rounded-xl border border-charcoal-dark bg-charcoal-light/50 p-6 md:p-8">
          <h1 className="text-xl font-semibold text-gray-100 mb-2">Contact</h1>
          <p className="text-gray-400 text-sm mb-6">
            Get in touch about Stash or report an issue.
          </p>
          {CONTACT_EMAIL ? (
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="inline-flex items-center gap-2 text-accent hover:text-accent-light transition-colors"
            >
              <Mail className="w-4 h-4" />
              {CONTACT_EMAIL}
            </a>
          ) : (
            <p className="inline-flex items-center gap-2 text-gray-400 text-sm">
              <Mail className="w-4 h-4" />
              Set NEXT_PUBLIC_CONTACT_EMAIL to display a contact address.
            </p>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
