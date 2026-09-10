"use server";

import { revalidatePath } from "next/cache";
import { refreshPrices } from "@/lib/prices";

export async function refreshPricesAction() {
  await refreshPrices();
  revalidatePath("/");
}
