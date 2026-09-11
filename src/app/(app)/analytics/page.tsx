import { ChartLine } from "lucide-react";
import { ComingSoon } from "@/components/ComingSoon";

export const metadata = { title: "Analytics · CryptoPort" };

export default function AnalyticsPage() {
  return (
    <ComingSoon
      title="Analytics"
      description="Deeper performance breakdowns, trends and historical charts."
      icon={ChartLine}
    />
  );
}
