import React, { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle,
  DialogFooter
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { authHeaders } from "@/services/auth";
import type { InventoryItem } from "@/components/inventory/inventory-list";
import { Loader2, Image as ImageIcon } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

const formSchema = z.object({
  name: z.string().min(1, "El nombre es requerido"),
  category: z.enum(["plant", "material", "tool", "other"]),
  quantity: z.coerce.number().min(0, "La cantidad debe ser 0 o mayor"),
  unit: z.string().min(1, "La unidad es requerida (ej: u, kg, m)"),
  status: z.enum(["available", "low", "out_of_stock"]),
  notes: z.string().optional(),
  price: z.coerce.number().min(0, "El precio no puede ser negativo").optional(),
  itemType: z.string().optional(),
  size: z.string().optional(),
  spacing: z.coerce.number().optional(),
  imageData: z.string().optional().nullable()
});

type FormValues = z.infer<typeof formSchema>;

interface ItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item?: InventoryItem | null;
}

export default function ItemDialog({ open, onOpenChange, item }: ItemDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isEditing = !!item;
  const [imageBase64, setImageBase64] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      category: "plant",
      quantity: 1,
      unit: "u",
      status: "available",
      notes: "",
      price: 0,
      itemType: "planta",
      size: "",
      spacing: 0,
      imageData: null
    },
  });

  useEffect(() => {
    if (item && open) {
      form.reset({
        name: item.name,
        category: item.category as any,
        quantity: item.quantity,
        unit: item.unit,
        status: item.status as any,
        notes: item.notes || "",
        price: item.price || 0,
        itemType: item.itemType || "planta",
        size: item.size || "",
        spacing: item.spacing || 0,
        imageData: item.imageData || null
      });
      // Si el item tiene imagen pero no la base64 (lista ligera), cargarla desde la API
      if (item.imageData) {
        setImageBase64(item.imageData);
      } else if (item.hasImage) {
        setImageBase64(`/api/inventory/${item.id}/image`);
      } else {
        setImageBase64(null);
      }
    } else if (!item && open) {
      form.reset({
        name: "",
        category: "plant",
        quantity: 1,
        unit: "u",
        status: "available",
        notes: "",
        price: 0,
        itemType: "planta",
        size: "",
        spacing: 0,
        imageData: null
      });
      setImageBase64(null);
    }
  }, [item, open, form]);

  const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

  const createMutation = useMutation({
    mutationFn: async ({ data }: { data: FormValues }) => {
      const res = await fetch(`${API_BASE}/api/inventory`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Create failed');
      return res.json();
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: FormValues }) => {
      const res = await fetch(`${API_BASE}/api/inventory/${id}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Update failed');
      return res.json();
    },
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      if (typeof event.target?.result === "string") {
        setImageBase64(event.target.result);
        form.setValue("imageData", event.target.result);
      }
    };
    reader.onerror = () => {
      toast({
        title: "Error",
        description: "No se pudo leer la imagen.",
        variant: "destructive",
      });
    };
    reader.readAsDataURL(file);
  };

  const onSubmit = (data: FormValues) => {
    if (isEditing && item) {
      updateMutation.mutate(
        { id: item.id, data },
        {
          onSuccess: () => {
            toast({ title: "Artículo actualizado" });
            queryClient.invalidateQueries({ queryKey: ['listInventoryItems'] });
            queryClient.invalidateQueries({ queryKey: ['getInventorySummary'] });
            onOpenChange(false);
          },
          onError: () => {
            toast({ title: "Error", description: "No se pudo actualizar.", variant: "destructive" });
          }
        }
      );
    } else {
      createMutation.mutate(
        { data },
        {
          onSuccess: () => {
            toast({ title: "Artículo creado" });
            queryClient.invalidateQueries({ queryKey: ['listInventoryItems'] });
            queryClient.invalidateQueries({ queryKey: ['getInventorySummary'] });
            onOpenChange(false);
          },
          onError: () => {
            toast({ title: "Error", description: "No se pudo crear.", variant: "destructive" });
          }
        }
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] rounded-2xl max-h-[90vh] p-0 flex flex-col overflow-hidden">
        <DialogHeader className="p-6 pb-4 border-b border-border shrink-0">
          <DialogTitle>{isEditing ? "Editar Artículo" : "Nuevo Artículo"}</DialogTitle>
        </DialogHeader>
        
        <ScrollArea className="flex-1 px-6">
          <Form {...form}>
            <form id="item-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 py-4">
              
              <div className="flex justify-center mb-6">
                 <div className="relative group">
                    <div className="w-24 h-24 rounded-2xl overflow-hidden bg-muted flex flex-col items-center justify-center border-2 border-dashed border-border hover:border-primary/50 transition-colors cursor-pointer relative shadow-sm">
                      {imageBase64 ? (
                        <img src={imageBase64} alt="Preview" className="w-full h-full object-cover" />
                      ) : (
                        <ImageIcon className="w-8 h-8 text-muted-foreground mb-1" />
                      )}
                      {!imageBase64 && <span className="text-[10px] text-muted-foreground font-medium">Subir foto</span>}
                      <input 
                        type="file" 
                        accept="image/png, image/jpeg" 
                        onChange={handleImageUpload}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      />
                    </div>
                    {imageBase64 && (
                      <Button 
                        size="sm" 
                        variant="secondary" 
                        className="absolute -bottom-3 -right-3 h-6 text-[10px] shadow-sm rounded-full"
                        onClick={(e) => { e.preventDefault(); setImageBase64(null); form.setValue("imageData", null); }}
                      >
                        Quitar
                      </Button>
                    )}
                 </div>
              </div>

              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nombre</FormLabel>
                    <FormControl>
                      <Input placeholder="Ej: Monstera Deliciosa" {...field} className="rounded-xl h-12" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="category"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Categoría</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger className="rounded-xl h-12">
                            <SelectValue placeholder="Seleccionar" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="plant">Planta</SelectItem>
                          <SelectItem value="material">Material</SelectItem>
                          <SelectItem value="tool">Herramienta</SelectItem>
                          <SelectItem value="other">Otro</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="itemType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tipo visual</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger className="rounded-xl h-12">
                            <SelectValue placeholder="Seleccionar" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="arbol">Árbol</SelectItem>
                          <SelectItem value="planta">Planta</SelectItem>
                          <SelectItem value="arbusto">Arbusto</SelectItem>
                          <SelectItem value="piedra">Piedra</SelectItem>
                          <SelectItem value="pasto">Pasto</SelectItem>
                          <SelectItem value="otro">Otro</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <FormField
                  control={form.control}
                  name="quantity"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Cantidad</FormLabel>
                      <FormControl>
                        <Input type="number" min="0" step="1" {...field} className="rounded-xl h-12" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="unit"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Unidad</FormLabel>
                      <FormControl>
                        <Input placeholder="u, kg, m" {...field} className="rounded-xl h-12" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name="price"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Precio Unit. ($)</FormLabel>
                      <FormControl>
                        <Input type="number" min="0" step="0.01" {...field} className="rounded-xl h-12" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="size"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tamaño descriptivo</FormLabel>
                      <FormControl>
                        <Input placeholder="Ej: Grande, 50x50" {...field} className="rounded-xl h-12" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="spacing"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Espaciado (cm)</FormLabel>
                      <FormControl>
                        <Input type="number" min="0" {...field} className="rounded-xl h-12" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Estado</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger className="rounded-xl h-12">
                          <SelectValue placeholder="Seleccionar" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="available">Disponible</SelectItem>
                        <SelectItem value="low">Poco stock</SelectItem>
                        <SelectItem value="out_of_stock">Agotado</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notas</FormLabel>
                    <FormControl>
                      <Textarea 
                        placeholder="Detalles adicionales..." 
                        className="resize-none rounded-xl" 
                        {...field} 
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

            </form>
          </Form>
        </ScrollArea>
        <DialogFooter className="p-6 border-t border-border shrink-0 bg-card">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="rounded-xl h-12 px-6">
            Cancelar
          </Button>
          <Button type="submit" form="item-form" disabled={isPending} className="rounded-xl h-12 px-6 shadow-md">
            {isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {isEditing ? "Guardar Cambios" : "Crear Artículo"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
