import { LayoutDashboard } from "lucide-react";
import { ComingSoon } from "@/components/ComingSoon";

export const metadata = { title: "Dashboard · CryptoPort" };

export default function DashboardPage() {
  return (
    <ComingSoon
      title="Dashboard"
      description="Portfolio overview, allocation and performance at a glance."
      icon={LayoutDashboard}
    />
  );
}
