-- A RecipeLine belongs to EXACTLY ONE parent: a MenuItem's recipe, or a
-- SEMI_FINISHED Ingredient's own recipe (never both, never neither).
ALTER TABLE "RecipeLine"
  ADD CONSTRAINT "recipe_line_exactly_one_parent"
  CHECK (
    ("menuItemId" IS NOT NULL AND "parentIngredientId" IS NULL)
    OR ("menuItemId" IS NULL AND "parentIngredientId" IS NOT NULL)
  );
