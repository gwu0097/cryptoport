import { Coins } from "lucide-react";
import { ComingSoon } from "@/components/ComingSoon";

export const metadata = { title: "Assets · CryptoPort" };

export default function AssetsPage() {
  return (
    <ComingSoon
      title="Assets"
      description="Every holding across all your wallets, in one consolidated view."
      icon={Coins}
    />
  );
}
