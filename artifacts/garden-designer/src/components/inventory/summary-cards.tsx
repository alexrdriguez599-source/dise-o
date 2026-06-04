import React from "react";
import { Package, AlertTriangle, AlertOctagon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
interface InventorySummary {
  total: number;
  byStatus?: Record<string, number>;
  byCategory?: Record<string, number>;
}

interface SummaryCardsProps {
  summary: InventorySummary;
}

export default function SummaryCards({ summary }: SummaryCardsProps) {
  const lowStockCount = summary.byStatus?.low || 0;
  const outOfStockCount = summary.byStatus?.out_of_stock || 0;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Card className="bg-card shadow-sm border-border">
        <CardContent className="p-6 flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <Package className="w-6 h-6 text-primary" />
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">Total Artículos</p>
            <h3 className="text-3xl font-bold">{summary.total}</h3>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card shadow-sm border-border">
        <CardContent className="p-6 flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-amber-500/10 flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-amber-600 dark:text-amber-500" />
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">Poco Stock</p>
            <h3 className="text-3xl font-bold">{lowStockCount}</h3>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card shadow-sm border-border">
        <CardContent className="p-6 flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-destructive/10 flex items-center justify-center">
            <AlertOctagon className="w-6 h-6 text-destructive" />
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">Agotado</p>
            <h3 className="text-3xl font-bold">{outOfStockCount}</h3>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
