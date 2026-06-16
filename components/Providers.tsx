"use client";

import { MonthProvider } from "@/contexts/MonthContext";
import { RefreshProvider } from "@/contexts/RefreshContext";
import { ExpensesDataProvider } from "@/contexts/ExpensesDataContext";
import { AccountsProvider } from "@/contexts/AccountsContext";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <MonthProvider>
      <RefreshProvider>
        <AccountsProvider>
          <ExpensesDataProvider>{children}</ExpensesDataProvider>
        </AccountsProvider>
      </RefreshProvider>
    </MonthProvider>
  );
}
