-- An OrderLine belongs to EXACTLY ONE parent: a regular menu item sale,
-- or a combo-meal sale (never both, never neither) -- same shape as
-- RecipeLine's own menuItemId/parentIngredientId constraint.
ALTER TABLE "OrderLine"
  ADD CONSTRAINT "order_line_exactly_one_parent"
  CHECK (
    ("menuItemId" IS NOT NULL AND "comboMealId" IS NULL)
    OR ("menuItemId" IS NULL AND "comboMealId" IS NOT NULL)
  );
