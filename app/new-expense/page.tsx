"use client";

import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import GlassDropdown from "@/components/GlassDropdown";
import { useRefresh } from "@/contexts/RefreshContext";
import { submitExpense } from "@/services/sheetsApi";
import { EXPENSE_TYPE_OPTIONS } from "@/lib/constants";
import { Loader2, Smartphone, X } from "lucide-react";
import Link from "next/link";

export default function NewExpensePage() {
  const { triggerRefresh } = useRefresh();
  const [expenseType, setExpenseType] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [showWidgetHelp, setShowWidgetHelp] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const num = parseFloat(amount);
    if (!expenseType || Number.isNaN(num) || num <= 0) {
      setStatus("error");
      setErrorMessage("Please select a type and enter a valid amount.");
      return;
    }
    setStatus("submitting");
    setErrorMessage("");
    try {
      await submitExpense({
        expenseType,
        amount: num,
        description: description.trim(),
      });
      triggerRefresh();
      setStatus("success");
      setAmount("");
      setDescription("");
      setExpenseType("");
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Failed to submit.");
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-2xl">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold text-white">New Expense</h1>
          <button
            type="button"
            onClick={() => setShowWidgetHelp(true)}
            className="px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-300 hover:text-white hover:border-accent/50 transition-colors flex items-center gap-2 text-sm"
          >
            <Smartphone className="w-4 h-4" />
            iPhone Widget Setup
          </button>
        </div>

        <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
          <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
            <h2 className="text-white font-medium">Add transaction</h2>
          </div>
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <div>
              <label htmlFor="expenseType" className="block text-sm font-medium text-gray-300 mb-1">
                Expense Type
              </label>
              <GlassDropdown
                id="expenseType"
                value={expenseType}
                onChange={setExpenseType}
                options={EXPENSE_TYPE_OPTIONS.map((opt) => ({ value: opt, label: opt }))}
                placeholder="Select type"
                className="w-full"
                aria-label="Expense type"
              />
            </div>

            <div>
              <label htmlFor="amount" className="block text-sm font-medium text-gray-300 mb-1">
                Amount
              </label>
              <input
                id="amount"
                type="number"
                step="0.01"
                min="0"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 focus:border-accent focus:ring-1 focus:ring-accent outline-none"
              />
            </div>

            <div>
              <label htmlFor="description" className="block text-sm font-medium text-gray-300 mb-1">
                Description
              </label>
              <input
                id="description"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional notes"
                className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 focus:border-accent focus:ring-1 focus:ring-accent outline-none"
              />
            </div>

            {status === "error" && (
              <p className="text-sm text-red-400">{errorMessage}</p>
            )}
            {status === "success" && (
              <p className="text-sm text-accent">Saved. Dashboard will reflect the new transaction.</p>
            )}

            <div className="flex gap-3 pt-2">
              <button
                type="submit"
                disabled={status === "submitting"}
                className="px-4 py-2 rounded-lg bg-accent text-white font-medium hover:bg-accent-dark disabled:opacity-50 flex items-center gap-2"
              >
                {status === "submitting" ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Save"
                )}
              </button>
              <Link
                href="/"
                className="px-4 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-300 hover:text-white hover:border-accent/50 transition-colors"
              >
                View Budget
              </Link>
            </div>
          </form>
        </div>
      </div>

      {showWidgetHelp && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:p-6"
          onClick={() => setShowWidgetHelp(false)}
        >
          <div
            className="my-4 w-full max-w-2xl rounded-xl bg-[#252525] border border-charcoal-dark shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 bg-[#353535] border-b border-charcoal-dark rounded-t-xl">
              <h2 className="text-white font-medium flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-accent" />
                iPhone Shortcut Setup
              </h2>
              <button
                type="button"
                onClick={() => setShowWidgetHelp(false)}
                className="text-gray-400 hover:text-white transition-colors"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-5 text-sm text-gray-300">
              <p>
                Add a Home Screen button (or Back Tap) on your iPhone that records a new entry
                straight to your budget — no need to open this site.
              </p>

              <div>
                <h3 className="text-white font-medium mb-1">Before you start</h3>
                <p>
                  You need your <span className="text-white font-medium">Google Apps Script Web App URL</span>.
                  It&apos;s in <span className="text-accent font-medium">cell I1</span> of your Google Sheet and ends in{" "}
                  <code className="px-1 py-0.5 rounded bg-charcoal text-gray-200">/exec</code>. Tap the cell,
                  copy the full URL, and have it ready to paste below.
                </p>
              </div>

              <div>
                <h3 className="text-white font-medium mb-2">Build the shortcut</h3>
                <ol className="list-decimal list-outside ml-5 space-y-2">
                  <li>
                    Open the <span className="text-white">Shortcuts</span> app → tap{" "}
                    <span className="text-white">+</span> to create a new shortcut and name it something
                    like <span className="text-white">&ldquo;Add Expense&rdquo;</span>.
                  </li>
                  <li>
                    Add <span className="text-white">Ask for Input</span> → set type to{" "}
                    <span className="text-white">Number</span>, prompt{" "}
                    <span className="text-white">&ldquo;Amount&rdquo;</span>.
                  </li>
                  <li>
                    Add another <span className="text-white">Ask for Input</span> → type{" "}
                    <span className="text-white">Text</span>, prompt{" "}
                    <span className="text-white">&ldquo;Category&rdquo;</span>. (Tip: to avoid typos, use{" "}
                    <span className="text-white">Choose from Menu</span> instead and add one menu item per
                    category from the list below.)
                  </li>
                  <li>
                    Add a third <span className="text-white">Ask for Input</span> → type{" "}
                    <span className="text-white">Text</span>, prompt{" "}
                    <span className="text-white">&ldquo;Description&rdquo;</span>.
                  </li>
                  <li>
                    Add <span className="text-white">Get Contents of URL</span> and configure it:
                    <ul className="list-disc list-outside ml-5 mt-1 space-y-1">
                      <li>
                        <span className="text-white">URL:</span> paste the{" "}
                        <code className="px-1 py-0.5 rounded bg-charcoal text-gray-200">/exec</code> URL from
                        cell I1.
                      </li>
                      <li>
                        <span className="text-white">Method:</span> POST
                      </li>
                      <li>
                        <span className="text-white">Request Body:</span> JSON, with these three fields:
                        <ul className="list-disc list-outside ml-5 mt-1 space-y-1">
                          <li>
                            <code className="px-1 py-0.5 rounded bg-charcoal text-gray-200">amount</code>{" "}
                            (Number) → the <span className="text-white">Amount</span> input from step 2
                          </li>
                          <li>
                            <code className="px-1 py-0.5 rounded bg-charcoal text-gray-200">expenseType</code>{" "}
                            (Text) → the <span className="text-white">Category</span> input from step 3
                          </li>
                          <li>
                            <code className="px-1 py-0.5 rounded bg-charcoal text-gray-200">description</code>{" "}
                            (Text) → the <span className="text-white">Description</span> input from step 4
                          </li>
                        </ul>
                      </li>
                    </ul>
                  </li>
                  <li>
                    (Optional) Add <span className="text-white">Show Notification</span> at the end so you get
                    a confirmation each time.
                  </li>
                  <li>
                    Tap the shortcut&apos;s settings → <span className="text-white">Add to Home Screen</span>{" "}
                    (or assign it to <span className="text-white">Back Tap</span> in Settings → Accessibility →
                    Touch).
                  </li>
                </ol>
              </div>

              <div className="rounded-lg border border-accent/40 bg-accent/10 p-3">
                <h3 className="text-white font-medium mb-1">Categories — type them exactly</h3>
                <p className="mb-2">
                  The <span className="text-white">Category</span> value must match one of these{" "}
                  <span className="text-white">exactly</span> — same spelling and capitalization (including the
                  period in <span className="text-white">&ldquo;Misc.&rdquo;</span>). A mismatch will file the
                  entry under the wrong category or none at all.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {EXPENSE_TYPE_OPTIONS.map((cat) => (
                    <code
                      key={cat}
                      className="px-2 py-1 rounded bg-charcoal border border-charcoal-dark text-gray-200"
                    >
                      {cat}
                    </code>
                  ))}
                </div>
              </div>
            </div>

            <div className="px-5 py-3 border-t border-charcoal-dark flex justify-end">
              <button
                type="button"
                onClick={() => setShowWidgetHelp(false)}
                className="px-4 py-2 rounded-lg bg-accent text-white font-medium hover:bg-accent-dark"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
