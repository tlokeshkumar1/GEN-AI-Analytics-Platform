"""Small arithmetic language for reviewed derived definitions; deliberately no eval."""
import ast
import operator
from decimal import Decimal, localcontext


def formula(expression, values):
    root = ast.parse(expression, mode="eval")
    nodes = list(ast.walk(root))
    if len(nodes) > 80:
        raise ValueError("Formula is too complex")
    allowed = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Name, ast.Load, ast.Constant,
               ast.Add, ast.Sub, ast.Mult, ast.Div, ast.USub, ast.UAdd)
    if any(not isinstance(node, allowed) for node in nodes):
        raise ValueError("Only arithmetic over approved dependency names is allowed")
    def calculate(node):
        if isinstance(node, ast.Expression):
            return calculate(node.body)
        if isinstance(node, ast.Name):
            if node.id not in values:
                raise ValueError(f"Unknown formula dependency '{node.id}'")
            return values[node.id]
        if isinstance(node, ast.Constant):
            if type(node.value) not in (int, float):
                raise ValueError("Formula constants must be numeric")
            return Decimal(ast.get_source_segment(expression, node))
        if isinstance(node, ast.UnaryOp):
            value = calculate(node.operand)
            return None if value is None else -value if isinstance(node.op, ast.USub) else value
        left, right = calculate(node.left), calculate(node.right)
        if left is None or right is None or (isinstance(node.op, ast.Div) and right == 0):
            return None
        action = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv}[type(node.op)]
        return action(Decimal(str(left)), Decimal(str(right)))
    with localcontext() as context:
        context.prec = 38
        result = calculate(root)
        if result is not None and not result.is_finite():
            raise ValueError("Formula produced a non-finite result")
        return result


def validated_join(left, right, relationship, how="left"):
    """Revalidate cardinality at execution; reject any join that can inflate totals."""
    if len(relationship.left_keys) != len(relationship.right_keys):
        raise ValueError("Join keys must have equal lengths")
    if not set(relationship.left_keys) <= set(left) or not set(relationship.right_keys) <= set(right):
        raise ValueError("Relationship references missing key fields")
    right = right.dropna(subset=relationship.right_keys)
    if right.duplicated(relationship.right_keys).any():
        raise ValueError("The right join key is not unique; joining would multiply rows")
    if relationship.cardinality == "one_to_one" and left.dropna(subset=relationship.left_keys).duplicated(relationship.left_keys).any():
        raise ValueError("The left join key is not unique for a one-to-one relationship")
    renamed = {column: f"{relationship.id}__{column}" for column in right}
    if set(renamed.values()) & set(left):
        raise ValueError("Relationship field namespace collides with existing fields")
    return left.merge(right.rename(columns=renamed), left_on=relationship.left_keys,
                      right_on=[renamed[key] for key in relationship.right_keys], how=how,
                      validate=relationship.cardinality)
