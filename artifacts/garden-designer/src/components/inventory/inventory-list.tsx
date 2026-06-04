import React from "react";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Edit2, Trash2, Loader2, MoreHorizontal, Image as ImageIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { authHeaders } from "@/services/auth";

export interface InventoryItem {
  id: number;
  name: string;
  category: string;
  itemType?: string;
  quantity: number;
  unit: string;
  status: string;
  notes?: string;
  price?: number;
  hasImage?: boolean;
  imageData?: string;
  size?: string;
  spacing?: number;
}
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface InventoryListProps {
  items: InventoryItem[];
  isLoading: boolean;
  onEdit: (item: InventoryItem) => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  plant: "Planta",
  material: "Material",
  tool: "Herramienta",
  other: "Otro"
};

const STATUS_LABELS: Record<string, string> = {
  available: "Disponible",
  low: "Poco stock",
  out_of_stock: "Agotado"
};

const STATUS_COLORS: Record<string, string> = {
  available: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800",
  low: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800",
  out_of_stock: "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800"
};

export default function InventoryList({ items, isLoading, onEdit }: InventoryListProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/inventory/${id}`, { method: 'DELETE', credentials: 'include', headers: authHeaders() });
      if (!res.ok) throw new Error('Delete failed');
    },
    onSuccess: () => {
      toast({ title: "Artículo eliminado", description: "El artículo ha sido eliminado del inventario." });
      queryClient.invalidateQueries({ queryKey: ['listInventoryItems'] });
      queryClient.invalidateQueries({ queryKey: ['getInventorySummary'] });
    },
    onError: () => {
      toast({ title: "Error", description: "No se pudo eliminar el artículo.", variant: "destructive" });
    },
  });

  const handleDelete = (id: number) => {
    deleteMutation.mutate(id);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-12 border-2 border-dashed border-border rounded-xl">
        <p className="text-muted-foreground">No se encontraron artículos.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border overflow-hidden bg-background">
      <Table>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead className="w-12"></TableHead>
            <TableHead>Nombre</TableHead>
            <TableHead>Categoría / Tipo</TableHead>
            <TableHead>Precio</TableHead>
            <TableHead>Cantidad</TableHead>
            <TableHead>Estado</TableHead>
            <TableHead className="text-right">Acciones</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.id}>
              <TableCell>
                <div className="w-8 h-8 rounded-md overflow-hidden bg-muted flex items-center justify-center border border-border">
                  {(item.hasImage || item.imageData) ? (
                    <img src={item.imageData || `/api/inventory/${item.id}/image`} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <ImageIcon className="w-4 h-4 text-muted-foreground opacity-50" />
                  )}
                </div>
              </TableCell>
              <TableCell className="font-medium">
                {item.name}
                {item.notes && <p className="text-xs text-muted-foreground font-normal truncate max-w-[200px]">{item.notes}</p>}
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-1">
                  <Badge variant="secondary" className="font-normal w-fit">
                    {CATEGORY_LABELS[item.category] || item.category}
                  </Badge>
                  {item.itemType && <span className="text-[10px] text-muted-foreground capitalize">{item.itemType}</span>}
                </div>
              </TableCell>
              <TableCell>
                ${(item.price || 0).toLocaleString()}
              </TableCell>
              <TableCell>
                {item.quantity} <span className="text-muted-foreground text-sm">{item.unit}</span>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className={`font-medium ${STATUS_COLORS[item.status] || ""}`}>
                  {STATUS_LABELS[item.status] || item.status}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="h-8 w-8 p-0">
                      <span className="sr-only">Abrir menú</span>
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-[160px]">
                    <DropdownMenuItem onClick={() => onEdit(item)} className="cursor-pointer">
                      <Edit2 className="mr-2 h-4 w-4" />
                      <span>Editar</span>
                    </DropdownMenuItem>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <DropdownMenuItem onSelect={(e) => e.preventDefault()} className="cursor-pointer text-destructive focus:text-destructive">
                          <Trash2 className="mr-2 h-4 w-4" />
                          <span>Eliminar</span>
                        </DropdownMenuItem>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>¿Eliminar {item.name}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            Esta acción no se puede deshacer. Se eliminará permanentemente del inventario.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancelar</AlertDialogCancel>
                          <AlertDialogAction 
                            onClick={() => handleDelete(item.id)}
                            className="bg-destructive hover:bg-destructive/90"
                          >
                            Eliminar
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
