import { ArrowLeftRight } from "lucide-react";
import { ComingSoon } from "@/components/ComingSoon";

export const metadata = { title: "Transactions · CryptoPort" };

export default function TransactionsPage() {
  return (
    <ComingSoon
      title="Transactions"
      description="Your on-chain and manual transaction history."
      icon={ArrowLeftRight}
    />
  );
}
