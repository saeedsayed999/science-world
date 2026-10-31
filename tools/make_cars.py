"""Generates every car in the game from data and exports assets/cars/<id>.glb.

Run headless:
  blender -b --factory-startup -P tools/make_cars.py -- assets/cars          # export all
  blender -b --factory-startup -P tools/make_cars.py -- assets/cars --preview /tmp/out   # + PNG previews

Each car is a loft of cross-sections (stations) along its length, smoothed with
one subdivision level, with wheel arches cut by booleans. Lights are dropped
onto the real body surface with ray casts. Designs are original; shapes are
inspired by car classes, with no logos, badges or brand names.

Front faces Blender -Y, which the glTF exporter turns into +Z (the game's forward).
Material names are a contract with js/cars.js: Body is recoloured per car.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0] if argv else "cars"
PREVIEW = argv[argv.index("--preview") + 1] if "--preview" in argv else None
ONLY = argv[argv.index("--only") + 1].split(",") if "--only" in argv else None

# ---------- car data ----------
# stations: (t along length 0=front..1=rear, half-width fraction, z bottom, z top, squareness)
# cabin: same, z bottom = beltline, z top = roof. Wheels: (front t, rear t, radius, width).
CARS = {
    "rookie": dict(L=4.3, W=1.85, sq=3.4, wheels=(0.17, 0.80, 0.34, 0.26), lamps="rect", tail="bar", spoiler="wing", caliper=(0.85, 0.1, 0.1),
        body=[(0, .80, .24, .56), (.06, .93, .20, .68), (.30, .97, .20, .74), (.55, .96, .20, .78), (.78, .99, .20, .82), (.94, .95, .24, .80), (1, .86, .30, .72)],
        cabin=[(.32, .70, .72, .78), (.44, .66, .72, 1.20), (.60, .64, .72, 1.24), (.78, .58, .76, 1.02), (.90, .50, .80, .86)]),
    "metro": dict(L=4.0, W=1.76, sq=4.2, wheels=(0.15, 0.84, 0.31, 0.22), lamps="rect", tail="split", spoiler="roof", caliper=None,
        body=[(0, .85, .28, .66), (.06, .95, .24, .80), (.25, .97, .22, .86), (.55, .97, .22, .90), (.85, .97, .24, .92), (.97, .94, .28, .92), (1, .90, .32, .90)],
        cabin=[(.26, .76, .84, .90), (.40, .72, .84, 1.40), (.70, .72, .84, 1.46), (.90, .70, .86, 1.40), (.99, .66, .88, 1.20)]),
    "sedan": dict(L=4.65, W=1.82, sq=4.0, wheels=(0.17, 0.80, 0.32, 0.22), lamps="rect", tail="split", spoiler=None, caliper=None,
        body=[(0, .85, .28, .66), (.06, .95, .24, .78), (.28, .97, .22, .82), (.55, .97, .22, .86), (.82, .97, .24, .90), (.96, .94, .28, .90), (1, .88, .34, .86)],
        cabin=[(.30, .74, .82, .88), (.42, .70, .82, 1.40), (.66, .70, .82, 1.44), (.80, .66, .84, 1.20), (.88, .60, .86, .96)]),
    "trail": dict(L=4.6, W=1.86, sq=5.0, wheels=(0.17, 0.81, 0.38, 0.26), lamps="rect", tail="split", spoiler="roof", caliper=None, rails=True,
        body=[(0, .86, .38, .86), (.05, .96, .32, 1.00), (.25, .98, .30, 1.04), (.55, .98, .30, 1.06), (.85, .98, .32, 1.08), (.97, .95, .36, 1.08), (1, .90, .40, 1.04)],
        cabin=[(.26, .78, 1.02, 1.08), (.38, .74, 1.02, 1.70), (.75, .74, 1.02, 1.74), (.93, .72, 1.04, 1.66), (.99, .68, 1.06, 1.40)]),
    "sterling": dict(L=4.8, W=1.90, sq=4.6, wheels=(0.16, 0.78, 0.35, 0.28), lamps="angular", tail="split", spoiler="lip", caliper=(0.1, 0.3, 0.85), quad_exhaust=True,
        body=[(0, .85, .28, .62), (.05, .95, .22, .74), (.25, .98, .20, .80), (.50, .97, .20, .82), (.75, .99, .20, .86), (.93, .96, .24, .86), (1, .88, .30, .80)],
        cabin=[(.30, .74, .78, .84), (.44, .70, .78, 1.30), (.62, .68, .78, 1.34), (.78, .64, .80, 1.12), (.86, .58, .82, .92)]),
    "heritage": dict(L=4.5, W=1.85, sq=2.7, wheels=(0.15, 0.79, 0.34, 0.27), lamps="round", tail="bar", spoiler="ducktail", caliper=(0.95, 0.75, 0.1),
        body=[(0, .78, .30, .55), (.04, .90, .22, .66), (.12, .97, .20, .74), (.30, .93, .20, .76), (.45, .92, .20, .80), (.62, .98, .20, .86), (.80, 1.0, .22, .86), (.92, .96, .26, .82), (1, .85, .32, .70)],
        cabin=[(.30, .70, .70, .78), (.42, .66, .70, 1.25), (.55, .64, .70, 1.30), (.70, .62, .74, 1.18), (.86, .58, .80, .96), (.96, .50, .82, .86)]),
    "vortex": dict(L=5.1, W=2.0, sq=4.2, wheels=(0.16, 0.80, 0.42, 0.30), lamps="slim", tail="bar", spoiler="lip", caliper=(0.95, 0.75, 0.1), quad_exhaust=True,
        body=[(0, .82, .38, .82), (.05, .95, .30, .98), (.20, .99, .28, 1.04), (.50, .97, .28, 1.06), (.75, 1.0, .28, 1.08), (.93, .96, .32, 1.06), (1, .86, .40, .98)],
        cabin=[(.27, .74, 1.00, 1.06), (.40, .70, 1.00, 1.58), (.60, .68, 1.00, 1.62), (.78, .62, 1.02, 1.40), (.92, .52, 1.04, 1.12)]),
    "raptor": dict(L=4.8, W=2.03, sq=5.2, wheels=(0.17, 0.78, 0.36, 0.32), lamps="slim", tail="bar", spoiler="wing", caliper=(0.95, 0.75, 0.1), side_intake=True,
        body=[(0, .70, .20, .44), (.08, .92, .16, .58), (.28, .98, .15, .70), (.50, .97, .15, .82), (.72, 1.0, .16, .88), (.90, .98, .20, .88), (1, .90, .28, .80)],
        cabin=[(.28, .66, .66, .72), (.38, .62, .66, 1.08), (.55, .58, .66, 1.12), (.72, .52, .80, .98), (.85, .46, .86, .90)]),
    "phantom": dict(L=4.55, W=2.04, sq=3.0, wheels=(0.16, 0.79, 0.36, 0.32), lamps="slim", tail="bar", spoiler="wing", caliper=(0.85, 0.85, 0.9), side_intake=True,
        body=[(0, .75, .20, .50), (.06, .93, .16, .62), (.20, .99, .15, .70), (.45, .95, .15, .76), (.70, 1.0, .16, .88), (.90, .97, .22, .86), (1, .88, .28, .78)],
        cabin=[(.30, .62, .68, .74), (.42, .58, .68, 1.10), (.58, .56, .70, 1.14), (.74, .50, .82, .96), (.86, .44, .86, .90)]),
    "mythic": dict(L=4.7, W=2.05, sq=3.6, wheels=(0.16, 0.79, 0.36, 0.33), lamps="slim", tail="bar", spoiler="wing", caliper=(0.2, 0.9, 1.0), side_intake=True,
        body=[(0, .70, .18, .44), (.07, .93, .15, .58), (.24, .99, .14, .68), (.48, .96, .14, .78), (.70, 1.0, .15, .88), (.90, .98, .20, .88), (1, .90, .26, .80)],
        cabin=[(.29, .60, .64, .70), (.40, .56, .64, 1.06), (.56, .54, .66, 1.10), (.72, .48, .78, .94), (.84, .42, .84, .88)]),
}

# ---------- materials ----------

def make_mat(name, rgb, metal=0.0, rough=0.5, emit=None, alpha=1.0, coat=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*rgb, 1)
    p.inputs["Metallic"].default_value = metal
    p.inputs["Roughness"].default_value = rough
    if coat:
        p.inputs["Coat Weight"].default_value = coat
    if emit:
        p.inputs["Emission Color"].default_value = (*emit, 1)
        p.inputs["Emission Strength"].default_value = 2.0
    if alpha < 1:
        p.inputs["Alpha"].default_value = alpha
    m.diffuse_color = (*(emit or rgb), alpha)   # viewport/preview colour
    m.metallic, m.roughness = metal, rough
    return m


def materials(caliper):
    return {
        "Body": make_mat("Body", (0.8, 0.8, 0.8), metal=0.6, rough=0.25, coat=1.0),
        "Glass": make_mat("Glass", (0.03, 0.04, 0.06), metal=0.3, rough=0.05, alpha=0.75),
        "Trim": make_mat("Trim", (0.02, 0.02, 0.025), rough=0.55),
        "Chrome": make_mat("Chrome", (0.9, 0.9, 0.9), metal=1.0, rough=0.15),
        "Tire": make_mat("Tire", (0.03, 0.03, 0.03), rough=0.85),
        "Rim": make_mat("Rim", (0.55, 0.56, 0.6), metal=1.0, rough=0.3),
        "Caliper": make_mat("Caliper", caliper or (0.3, 0.3, 0.32), metal=0.2, rough=0.4),
        "Head": make_mat("Head", (0.9, 0.95, 1.0), emit=(0.9, 0.95, 1.0)),
        "Tail": make_mat("Tail", (0.5, 0.0, 0.0), emit=(1.0, 0.04, 0.03)),
    }

# ---------- geometry helpers ----------

def section(hw, zb, zt, sq, taper, n=24):
    """Rounded-rectangle cross-section, narrower at the top (tumblehome)."""
    pts = []
    zc, hh = (zb + zt) / 2, (zt - zb) / 2
    for i in range(n):
        a = 2 * math.pi * i / n
        c, s = math.cos(a), math.sin(a)
        e = 2 / (sq if s >= 0 else sq * 1.6)  # flatter underside
        x = math.copysign(abs(c) ** (2 / sq), c) * hw * (1 - taper * max(0.0, s))
        z = zc + math.copysign(abs(s) ** e, s) * hh
        pts.append((x, z))
    return pts


def loft(name, stations, L, W, sq, taper, mat):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rings = []
    for t, hwf, zb, zt in stations:
        y = -L / 2 + t * L
        rings.append([bm.verts.new((x, y, z)) for x, z in section(hwf * W / 2, zb, zt, sq, taper)])
    n = len(rings[0])
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


def apply_all(obj):
    bpy.context.view_layer.objects.active = obj
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def subdivide(obj, levels=1):
    mod = obj.modifiers.new("sub", "SUBSURF")
    mod.levels = levels
    mod.render_levels = levels
    apply_all(obj)


def cut(obj, cutter):
    mod = obj.modifiers.new("cut", "BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.object = cutter
    mod.solver = "EXACT"
    mod.material_mode = "TRANSFER"
    apply_all(obj)


def cyl(name, r, depth, loc, mat, verts=24, axis="X"):
    rot = (0, math.pi / 2, 0) if axis == "X" else (math.pi / 2, 0, 0) if axis == "Y" else (0, 0, 0)
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.data.materials.append(mat)
    return o


def box(name, size, loc, mat, rot=(0, 0, 0), bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    o.data.materials.append(mat)
    if bevel:
        b = o.modifiers.new("bev", "BEVEL")
        b.width = bevel
        b.segments = 2
        apply_all(o)
    return o


def surface(bvh, origin, direction):
    hit, normal, _, _ = bvh.ray_cast(Vector(origin), Vector(direction).normalized())
    return hit, normal


def place_on(obj, hit, normal, inset=0.01):
    """Orient obj so its local -Y points along the surface normal, then sink it slightly."""
    # Rear-facing parts start from +Y so the rotation never flips 180° around a random axis.
    base = Vector((0, 1, 0)) if normal.y > 0 else Vector((0, -1, 0))
    q = base.rotation_difference(normal)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = q
    obj.location = hit - normal * inset


def smooth(obj, angle=40):
    for p in obj.data.polygons:
        p.use_smooth = True
    mod = obj.modifiers.new("smooth", "NODES") if False else None
    if hasattr(obj.data, "set_sharp_from_angle"):
        obj.data.set_sharp_from_angle(angle=math.radians(angle))

# ---------- assembly ----------

def build(cid, spec):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    M = materials(spec.get("caliper"))
    L, W, sq = spec["L"], spec["W"], spec["sq"]
    tf, tr, r, ww = spec["wheels"]
    yf, yr = -L / 2 + tf * L, -L / 2 + tr * L
    parts = []

    body = loft("Body", spec["body"], L, W, sq, 0.12, M["Body"])
    subdivide(body, 2)
    # Wheel arches: cutters carry the Trim material so the wells come out black.
    for y in (yf, yr):
        for side in (-1, 1):
            c = cyl("cutter", r + 0.07, 0.9, (side * W / 2, y, r + 0.02), M["Trim"], verts=32)
            cut(body, c)
            bpy.data.objects.remove(c)
    smooth(body)
    parts.append(body)

    cabin = loft("Cabin", spec["cabin"], L, W, sq * 0.9, 0.28, M["Glass"])
    subdivide(cabin, 2)
    cabin.data.materials.append(M["Body"])
    # Roof panel in body colour (flat faces between windscreen top and rear-window top); the rest is glass.
    y0 = -L / 2 + spec["cabin"][1][0] * L + 0.05
    y1 = -L / 2 + spec["cabin"][-2][0] * L - 0.05
    for p in cabin.data.polygons:
        if p.normal.z > 0.9 and y0 < p.center.y < y1:
            p.material_index = 1
    smooth(cabin)
    parts.append(cabin)

    dg = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(body, dg)
    hw = W / 2

    # Front lamps, dropped onto the nose surface.
    style = spec["lamps"]
    for side in (-1, 1):
        x = side * hw * (0.62 if style != "round" else 0.6)
        ztop = spec["body"][1][3]
        hit, n = surface(bvh, (x, -L, ztop - (0.12 if style == "round" else 0.08)), (0, 1, 0))
        if not hit:
            continue
        if style == "round":
            bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=0.12)
            lamp = bpy.context.active_object
            lamp.scale = (1, 0.45, 1)
            bpy.ops.object.transform_apply(scale=True)
        elif style == "slim":
            lamp = box("Lamp", (0.42, 0.05, 0.05), (0, 0, 0), M["Head"], rot=(0, side * 0.12, 0))
        elif style == "angular":
            lamp = box("Lamp", (0.36, 0.05, 0.08), (0, 0, 0), M["Head"], rot=(0, side * -0.2, 0))
        else:
            lamp = box("Lamp", (0.32, 0.05, 0.09), (0, 0, 0), M["Head"])
        if style == "round":
            lamp.data.materials.append(M["Head"])
        place_on(lamp, hit, n, 0.02)
        parts.append(lamp)

    # Grille / intake: dark panel low on the nose.
    hit, n = surface(bvh, (0, -L, spec["body"][0][2] + 0.12), (0, 1, 0))
    if hit:
        g = box("Grille", (W * (0.45 if spec["sq"] > 4 else 0.38), 0.06, 0.14), (0, 0, 0), M["Trim"], bevel=0.02)
        place_on(g, hit, n, 0.02)
        parts.append(g)

    # Tail lamps.
    zt_tail = spec["body"][-2][3] - 0.08
    if spec["tail"] == "bar":
        hit, n = surface(bvh, (0, L, zt_tail), (0, -1, 0))
        if hit:
            bar = box("TailBar", (W * 0.82, 0.05, 0.05), (0, 0, 0), M["Tail"])
            place_on(bar, hit, n, 0.015)
            parts.append(bar)
    for side in (-1, 1):
        hit, n = surface(bvh, (side * hw * 0.7, L, zt_tail), (0, -1, 0))
        if hit:
            t = box("Tail", (0.34, 0.05, 0.1), (0, 0, 0), M["Tail"])
            place_on(t, hit, n, 0.015)
            parts.append(t)

    # Diffuser and exhausts.
    hit, n = surface(bvh, (0, L, spec["body"][-1][2] + 0.08), (0, -1, 0))
    if hit:
        d = box("Diffuser", (W * 0.6, 0.12, 0.12), (0, 0, 0), M["Trim"])
        place_on(d, hit, n, 0.03)
        parts.append(d)
        xs = (-0.42, -0.28, 0.28, 0.42) if spec.get("quad_exhaust") else (-0.35, 0.35)
        for x in xs:
            e = cyl("Exhaust", 0.045, 0.16, (x, hit.y + 0.02, hit.z - 0.02), M["Chrome"], verts=12, axis="Y")
            parts.append(e)

    # Spoilers.
    sp = spec.get("spoiler")
    yb = -L / 2 + 0.93 * L
    deck, _ = surface(bvh, (0, yb, 3), (0, 0, -1))
    rear_top = deck.z if deck else spec["body"][-3][3]
    if sp == "wing":
        parts.append(box("Wing", (W * 0.86, 0.32, 0.04), (0, yb, rear_top + 0.32), M["Trim"], rot=(0.12, 0, 0), bevel=0.01))
        for side in (-1, 1):
            parts.append(box("WingPost", (0.04, 0.12, 0.34), (side * W * 0.28, yb, rear_top + 0.15), M["Trim"]))
    elif sp == "ducktail":
        parts.append(box("Duck", (W * 0.7, 0.3, 0.05), (0, yb, rear_top + 0.01), M["Body"], rot=(-0.3, 0, 0), bevel=0.02))
    elif sp == "lip":
        parts.append(box("Lip", (W * 0.7, 0.14, 0.03), (0, yb, rear_top + 0.005), M["Trim"], rot=(-0.3, 0, 0)))
    elif sp == "roof":
        last = spec["cabin"][-1]
        parts.append(box("RoofSpoiler", (W * 0.62, 0.22, 0.04), (0, -L / 2 + last[0] * L + 0.02, last[3] + 0.02), M["Body"], rot=(-0.15, 0, 0)))

    if spec.get("rails"):
        roof = max(c[3] for c in spec["cabin"])
        for side in (-1, 1):
            parts.append(box("Rail", (0.04, L * 0.38, 0.04), (side * W * 0.3, -L / 2 + 0.6 * L, roof + 0.03), M["Chrome"]))
    if spec.get("side_intake"):
        for side in (-1, 1):
            hit, n = surface(bvh, (side * W, -L / 2 + 0.6 * L, 0.5), (-side, 0, 0))
            if hit:
                s = box("Intake", (0.5, 0.06, 0.16), (0, 0, 0), M["Trim"])
                place_on(s, hit, n, 0.03)
                parts.append(s)

    # Side mirrors, attached to the cabin side just behind the windscreen base.
    cab0 = spec["cabin"][0]
    cbvh = BVHTree.FromObject(cabin, bpy.context.evaluated_depsgraph_get())
    ym = -L / 2 + (cab0[0] + 0.07) * L
    for side in (-1, 1):
        hit, n = surface(cbvh, (side * W, ym, cab0[2] + 0.12), (-side, 0, 0))
        if hit:
            parts.append(box("Mirror", (0.2, 0.1, 0.09), (hit.x + side * 0.09, ym, hit.z), M["Body"], bevel=0.02))

    # Wheels: tyre, multi-spoke rim, caliper. Each wheel is one node so the game can spin it.
    wheel_nodes = []
    for label, y in (("F", yf), ("R", yr)):
        for side, sname in ((-1, "L"), (1, "R")):
            x = side * (hw * 0.93 - ww / 2)
            tire = cyl(f"Wheel_{label}{sname}", r, ww, (x, y, r), M["Tire"], verts=28)
            bev = tire.modifiers.new("bev", "BEVEL")
            bev.width = 0.04
            bev.segments = 2
            apply_all(tire)
            smooth(tire, 50)
            rim = cyl("Rim", r * 0.66, 0.05, (x + side * (ww / 2 - 0.02), y, r), M["Rim"], verts=20)
            spokes = []
            for k in range(5):
                a = k * 2 * math.pi / 5
                s = box("Spoke", (0.03, r * 1.2, 0.06), (x + side * (ww / 2), y, r), M["Rim"], rot=(a, 0, 0))
                spokes.append(s)
            hub = cyl("Hub", r * 0.16, 0.08, (x + side * (ww / 2 + 0.01), y, r), M["Chrome"], verts=12)
            for p in [rim, hub] + spokes:
                p.parent = tire
                p.matrix_parent_inverse = tire.matrix_world.inverted()
            if spec.get("caliper"):
                cal = box("Caliper", (0.06, 0.16, 0.12), (x + side * (ww / 2 - 0.08), y + 0.1, r + 0.08), M["Caliper"])
                parts.append(cal)  # calipers do not spin
            wheel_nodes.append(tire)

    # Join static parts into one mesh (fewer draw calls); wheels stay separate.
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    body.name = "Car"

    tris = 0
    for o in bpy.data.objects:
        if o.type == "MESH":
            tris += sum(len(p.vertices) - 2 for p in o.data.polygons)
    return tris


def export(path):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_apply=True, export_yup=True,
                              export_cameras=False, export_lights=False)


def preview(path, color=(0.85, 0.1, 0.1)):
    scene = bpy.context.scene
    bpy.data.materials["Body"].node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*color, 1)
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.render.resolution_x, scene.render.resolution_y = 640, 400
    scene.world = bpy.data.worlds.new("w")
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    cam.location = (5.2, -6.4, 2.6)
    cam.rotation_euler = (math.radians(72), 0, math.radians(39))
    cam.data.lens = 50
    scene.camera = cam
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


os.makedirs(OUT, exist_ok=True)
for cid, spec in CARS.items():
    if ONLY and cid not in ONLY:
        continue
    tris = build(cid, spec)
    export(os.path.join(OUT, f"{cid}.glb"))
    print(f"[make_cars] {cid}: {tris} triangles")
    if PREVIEW:
        os.makedirs(PREVIEW, exist_ok=True)
        preview(os.path.join(PREVIEW, f"{cid}.png"))
