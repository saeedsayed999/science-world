"""Builds the low-poly race car used in the game and exports assets/car.json
(embedded glTF; .json because the artifact host does not serve .glb).

Run headless:  blender -b --factory-startup -P tools/make_car.py -- car.glb
       node tools/glb_to_json.mjs car.glb assets/car.json

Design targets (phones + laptops): < 3k triangles, 7 shared materials,
no textures. The "Body" material is recoloured per car at runtime, so one
file serves every car in the race. Wheels are separate nodes so the game can
spin them. Front of the car faces glTF +Z (Blender -Y).
"""
import sys
import bpy
import bmesh

out = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "car.glb"

bpy.ops.wm.read_factory_settings(use_empty=True)


def mat(name, rgb, metal=0.0, rough=0.5, emit=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*rgb, 1)
    p.inputs["Metallic"].default_value = metal
    p.inputs["Roughness"].default_value = rough
    if emit:
        p.inputs["Emission Color"].default_value = (*emit, 1)
        p.inputs["Emission Strength"].default_value = 3.0
    return m


M = {
    "Body": mat("Body", (0.9, 0.9, 0.9), metal=0.4, rough=0.3),
    "Glass": mat("Glass", (0.02, 0.03, 0.05), metal=0.2, rough=0.1),
    "Trim": mat("Trim", (0.03, 0.03, 0.03), rough=0.6),
    "Tire": mat("Tire", (0.05, 0.05, 0.05), rough=0.9),
    "Rim": mat("Rim", (0.7, 0.7, 0.72), metal=0.9, rough=0.3),
    "Tail": mat("Tail", (0.6, 0.0, 0.0), emit=(1.0, 0.05, 0.05)),
    "Head": mat("Head", (0.9, 0.9, 0.8), emit=(1.0, 0.95, 0.8)),
}


def link(obj, material):
    obj.data.materials.append(M[material])
    bpy.context.collection.objects.link(obj)
    return obj


def prism(name, profile, width, material, x=0.0, bevel=0.0):
    """Extrude a side profile [(y, z), ...] across X (width)."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    half = width / 2
    left = [bm.verts.new((x - half, y, z)) for y, z in profile]
    right = [bm.verts.new((x + half, y, z)) for y, z in profile]
    bm.faces.new(left)
    bm.faces.new(list(reversed(right)))
    n = len(profile)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((left[i], left[j], right[j], right[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    obj = link(bpy.data.objects.new(name, me), material)
    if bevel:
        mod = obj.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = "ANGLE"
    return obj


def box(name, size, loc, material):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    bpy.ops.object.transform_apply(scale=True)
    obj.data.materials.append(M[material])
    return obj


def wheel(name, loc):
    bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.36, depth=0.3,
                                        location=loc, rotation=(0, 1.5708, 0))
    tire = bpy.context.active_object
    tire.name = name
    tire.data.materials.append(M["Tire"])
    side = 1 if loc[0] > 0 else -1
    bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=0.22, depth=0.04,
                                        location=(loc[0] + side * 0.14, loc[1], loc[2]),
                                        rotation=(0, 1.5708, 0))
    rim = bpy.context.active_object
    rim.data.materials.append(M["Rim"])
    # Parent rim to tire so the wheel node spins as one piece.
    rim.parent = tire
    rim.matrix_parent_inverse = tire.matrix_world.inverted()
    return tire


# Lower body: wedge nose, long hood, high tail.
prism("Body", [(-2.2, 0.2), (-2.28, 0.44), (-1.6, 0.64), (-0.8, 0.78),
               (1.5, 0.84), (2.2, 0.88), (2.22, 0.32), (1.9, 0.2)],
      1.95, "Body", bevel=0.06)
# Cabin: narrower glass canopy.
prism("Cabin", [(-0.9, 0.76), (-0.15, 1.14), (0.7, 1.12), (1.6, 0.84)],
      1.5, "Glass", bevel=0.04)
# Roof stripe in body colour so the canopy reads as a car roof, not a bubble.
prism("Roof", [(-0.12, 1.15), (0.68, 1.13), (0.72, 1.10), (-0.16, 1.12)],
      1.2, "Body")

box("Splitter", (2.0, 0.5, 0.06), (0, -2.15, 0.2), "Trim")
box("Diffuser", (1.7, 0.4, 0.18), (0, 2.1, 0.28), "Trim")
box("SkirtL", (0.06, 2.6, 0.14), (-0.98, 0.1, 0.27), "Trim")
box("SkirtR", (0.06, 2.6, 0.14), (0.98, 0.1, 0.27), "Trim")
box("Wing", (1.9, 0.38, 0.06), (0, 2.0, 1.16), "Trim")
box("WingPostL", (0.06, 0.12, 0.3), (-0.55, 2.0, 0.99), "Trim")
box("WingPostR", (0.06, 0.12, 0.3), (0.55, 2.0, 0.99), "Trim")
box("TailLight", (1.7, 0.05, 0.09), (0, 2.23, 0.74), "Tail")
box("HeadL", (0.42, 0.05, 0.08), (-0.6, -2.12, 0.55), "Head")
box("HeadR", (0.42, 0.05, 0.08), (0.6, -2.12, 0.55), "Head")

wheel("Wheel_FL", (-0.92, -1.35, 0.36))
wheel("Wheel_FR", (0.92, -1.35, 0.36))
wheel("Wheel_RL", (-0.92, 1.42, 0.36))
wheel("Wheel_RR", (0.92, 1.42, 0.36))

# Flat shading keeps the faceted low-poly look and avoids smoothing artifacts.
for o in bpy.data.objects:
    if o.type == "MESH":
        for poly in o.data.polygons:
            poly.use_smooth = False

bpy.ops.object.select_all(action="SELECT")
tris = 0
dg = bpy.context.evaluated_depsgraph_get()
for o in bpy.data.objects:
    if o.type == "MESH":
        me = o.evaluated_get(dg).to_mesh()
        tris += sum(len(p.vertices) - 2 for p in me.polygons)
print(f"[make_car] triangles={tris}")

bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_apply=True,
                          export_yup=True, export_cameras=False, export_lights=False)
print(f"[make_car] wrote {out}")
