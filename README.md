# antisphere-explorer

Proof-of-concept antisphere BSP tree renderer/constructive solid geometry.

An antisphere is a sphere defined by a normal, a distance to the surface from the origin along this normal, and a curvature.  Using this definition, planes can be represented as antispheres with curvature 0, and "hollows" (an inside-facing spherical cutout) can be represented by inverting the antisphere (giving it a negative curvature).

This means that CSG operations can be performed in the traditional way, with the addition of allowing spherical space divisions.  Similarly, BSP trees implemented with this concept can be constructed in such a way that they additionally achieve some of the advantages of bounding volume hierarchies.

This is raycaster implemented using this concept.
