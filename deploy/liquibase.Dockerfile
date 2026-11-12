# Liquibase with its MongoDB extension (Anexo B, "Instalar la extensión"): TWO packages — the extension
# (liquibase-mongodb, it teaches Liquibase the mongodb:// protocol) and the Java driver it needs
# (mongodb). Installing only the driver fails with "Driver class was not specified…".
# lpm, shipped with the image, installs the version of each package it knows for this Liquibase.
FROM liquibase/liquibase:4.29
RUN lpm add liquibase-mongodb mongodb --global
