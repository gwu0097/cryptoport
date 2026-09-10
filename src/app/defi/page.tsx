import { Layers } from "lucide-react";
import { ComingSoon } from "@/components/ComingSoon";

export const metadata = { title: "DeFi · CryptoPort" };

export default function DefiPage() {
  return (
    <ComingSoon
      title="DeFi"
      description="Lending, staking and liquidity positions across protocols."
      icon={Layers}
    />
  );
}
